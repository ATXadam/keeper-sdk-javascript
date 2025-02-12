import {
    ClientConfiguration,
    ClientConfigurationInternal,
    DeviceApprovalChannel,
    DeviceVerificationMethods,
    KeeperError,
    LoginError,
    TwoFactorChannelData
} from './configuration'
import {KeeperEndpoint, KeeperEnvironment} from "./endpoint";
import {KeyWrapper, platform} from "./platform";
import {
    chooseErrorMessage,
    decryptFromStorage,
    generateEncryptionKey, wrapPassword,
    generateUidBytes,
    isTwoFactorResultCode,
    normal64,
    normal64Bytes,
    resolvablePromise,
    webSafe64,
    webSafe64FromBytes
} from "./utils";
import {
    accountSummaryMessage,
    getEnterprisePublicKeyMessage,
    logoutV3Message, NN,
    requestCreateUserMessage,
    requestDeviceAdminApprovalMessage,
    requestDeviceVerificationMessage, RestActionMessage, RestInMessage,
    RestMessage, RestOutMessage,
    ssoServiceProviderRequestMessage,
    startLoginMessage,
    startLoginMessageFromSessionToken,
    twoFactorSend2FAPushMessage,
    twoFactorValidateMessage,
    validateAuthHashMessage,
    validateDeviceVerificationCodeMessage
} from './restMessages'
import {AccountSummary, Authentication} from './proto';
import IStartLoginRequest = Authentication.IStartLoginRequest;
import ITwoFactorSendPushRequest = Authentication.ITwoFactorSendPushRequest;
import TwoFactorExpiration = Authentication.TwoFactorExpiration;
import TwoFactorPushType = Authentication.TwoFactorPushType;
import TwoFactorChannelType = Authentication.TwoFactorChannelType;
import ISsoServiceProviderRequest = Authentication.ISsoServiceProviderRequest;
import LoginType = Authentication.LoginType;
import LoginMethod = Authentication.LoginMethod;
import IAccountSummaryElements = AccountSummary.IAccountSummaryElements;
import {RestCommand} from './commands'

function unifyLoginError(e: any): LoginError {
    if (e instanceof Error) {
        try {
            return JSON.parse(e.message);
        } catch (jsonError) {
            return {
                error: "unknown",
                message: e.message
            }
        }
    } else {
        return {
            error: e.result_code,
            message: e.result_code
        }
    }
}

type CloseReason = {
    code: number,
    reason: CloseReasonMessage
}

enum CloseReasonCode {
    CANNOT_ACCEPT = 1003,
    NOT_CONSISTENT = 1007,
    VIOLATED_POLICY = 1008,
    TRY_AGAIN_LATER = 1013,
}

type CloseReasonMessage = {
    close_reason:string
    key_id?:number
}

type SocketMessage = {
    event: 'received_totp'
    type: 'dna'
    passcode: string
}

export type SocketProxy = {
    onOpen: (callback: () => void) => void
    close: () => void
    onClose: (callback: (e:Event) => void) => void
    onError: (callback: (e: Event | Error) => void) => void
    onMessage: (callback: (e: Uint8Array) => void) => void
    send: (message: any) => void
    messageQueue: any[] // Since messages are type any here, make this an any array
}

export class SocketListener {
    private socket?: SocketProxy;
    private url: string
    private getConnectionRequest?: (Uint8Array) => Promise<string>
    // Listeners that receive all messages
    private messageListeners: Array<(data: any) => void>
    // Listeners that receive a single message
    private singleMessageListeners: Array<{
        resolve: (data: any) => void,
        reject: (errorMessage: string) => void
    }>
    // Listeners that receive all messages
    private closeListeners: Array<(data: any) => void>
    // Listeners that receive a single message
    private singleCloseListeners: Array<{
        resolve: (data: any) => void,
        reject: (errorMessage: string) => void
    }>
    // Listeners that signal a re-connected socket
    private onOpenListeners: Array<() => void>
    // The messageSessionUid
    private messageSessionUid?: Uint8Array

    private isConnected: boolean
    private reconnectTimeout?: ReturnType<typeof setTimeout>
    private currentBackoffSeconds: number
    private isClosedByClient: boolean

    constructor(url: string, messageSessionUid?: Uint8Array, getConnectionRequest?: (messageSessionUid:Uint8Array) => Promise<string>) {
        console.log('Connecting to ' + url)

        this.url = url
        this.closeListeners = []
        this.singleCloseListeners = []
        this.messageListeners = []
        this.singleMessageListeners = []
        this.onOpenListeners = []
        this.currentBackoffSeconds = SocketListener.getBaseReconnectionInterval()
        this.isClosedByClient = false
        this.isConnected = false
        if (getConnectionRequest) this.getConnectionRequest = getConnectionRequest

        if (messageSessionUid){
            this.messageSessionUid = messageSessionUid
            this.createWebsocket(this.messageSessionUid)
        } else {
            this.createWebsocket()
        }
    }

    async createWebsocket(messageSessionUid?:Uint8Array) {
        if (this.getConnectionRequest && messageSessionUid) {
            const connectionRequest = await this.getConnectionRequest(messageSessionUid)
            this.socket = platform.createWebsocket(`${this.url}/${connectionRequest}`)
        } else {
            this.socket = platform.createWebsocket(this.url)
        }

        this.socket.onOpen(() => {
            console.log('socket opened')
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout)
            }
            this.currentBackoffSeconds = SocketListener.getBaseReconnectionInterval()
            this.handleOnOpen()
        })

        this.socket.onClose(async (event: Event) => {
            if (this.isClosedByClient) {
                return
            }

            let reason
            this.isConnected = false

            try {
                reason = JSON.parse(event['reason'])
            } catch {
                console.log('Connection closed - no close reason.')
                this.reconnect()
                return
            }

            switch (event['code']){
                case CloseReasonCode.CANNOT_ACCEPT:
                    // Exact messages that can come from CANNOT_ACCEPT:
                    // - Push server is in progress of shutting down
                    // - Push server is not registered with KA
                    // - Cannot process encrypted message.xxxx

                    if(reason && reason.close_reason.includes('Push server')){
                        // Tell User to try again
                        this.handleClose({code:event['code'], reason})
                    } else {
                        // this would be an internal error and shouldnt reach here in production
                        console.error('Incorrect internal error: ', reason.close_reason)
                    }
                    break
                case CloseReasonCode.NOT_CONSISTENT:
                    // Error Message: device timestamp: {time} is off by {off_time}
                    //Tell User to adjust their system clock
                    this.handleClose({ code: event['code'], reason })
                    break
                case CloseReasonCode.VIOLATED_POLICY:
                    // Error Message: duplicate messageSessionUid=${messageSessionUid}
                    // Relogin if this happens
                    this.handleClose({ code: event['code'], reason })
                    break
                case CloseReasonCode.TRY_AGAIN_LATER:
                    // Error Message: throttled messageSessionUid=${messageSessionUid}
                    //Tell User to try again in 1 minute
                    this.handleClose({ code: event['code'], reason })
                    break
                default:
                    if (!this.isClosedByClient) {
                        this.reconnect()
                    }
            }
        })
        this.socket.onError((e: Event | Error) => {
            console.log('socket error: ' + e)
        })
        this.socket.onMessage(e => {
            this.handleMessage(e)
        })

        this.isConnected = true
    }

    registerLogin(sessionToken: string) {
        if (!this.socket) throw new Error('Socket not available')
        this.socket.send(sessionToken)
    }

    onOpen(callback: () => void): void {
        this.onOpenListeners.push(callback)
    }

    onClose(callback: () => void): void {
        if (!this.socket) throw new Error('Socket not available')
        this.socket.onClose(callback)
    }

    onError(callback: () => void): void {
        if (!this.socket) throw new Error('Socket not available')
        this.socket.onError(callback)
    }

    private handleOnOpen() {
        for (let callback of this.onOpenListeners) {
            callback()
        }
    }

    private handleMessage(messageData: Uint8Array): void {
        for (let callback of this.messageListeners) {
            callback(messageData)
        }

        for (let {resolve} of this.singleMessageListeners) {
            resolve(messageData)
        }
        this.singleMessageListeners.length = 0
    }

    private handleClose(messageData: {code: number, reason:CloseReasonMessage}): void {
        for (let callback of this.closeListeners) {
            callback(messageData)
        }

        for (let { resolve } of this.singleCloseListeners) {
            resolve(messageData)
        }
        this.singleCloseListeners.length = 0
    }

    onPushMessage(callback: (data: any) => void): void {
        this.messageListeners.push(callback)
    }

    onCloseMessage(callback: (data: any) => void): void {
        this.closeListeners.push(callback)
    }

    async getPushMessage(): Promise<any> {
        console.log('Awaiting web socket message...')
        return new Promise<any>((resolve, reject) => {
            this.singleMessageListeners.push({resolve, reject})
        })
    }

    private static getBaseReconnectionInterval(): number {
        return Math.random() * 5
    }

    private reconnect() {
        console.log(`Reconnecting websocket in ${this.currentBackoffSeconds.toFixed(2)} seconds...`)

        // schedule next reconnect attempt
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout)
        }
        this.reconnectTimeout = setTimeout(() => {
            this.createWebsocket(this.messageSessionUid)
        }, this.currentBackoffSeconds * 1000)

        this.currentBackoffSeconds = Math.min(this.currentBackoffSeconds * 2, 60) // Cap at 1 min, as suggested by docs
    }

    disconnect() {
        this.isConnected = false
        this.isClosedByClient = true
        this.socket?.close()
        this.socket = undefined
        this.messageListeners.length = 0

        this.currentBackoffSeconds = Math.random() * 5
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout)
        }
        this.singleMessageListeners.length = 0
    }

    getIsConnected(){
        return this.isConnected
    }
}

export function socketSendMessage(message: any, socket: WebSocket, createdSocket:any){
    switch (socket.readyState) {
        case 0:// CONNECTING
            if (createdSocket.messageQueue.indexOf(message) === -1) createdSocket.messageQueue.push(message)
            break;
        case 1:// OPEN
            if (createdSocket.messageQueue.indexOf(message) === -1) createdSocket.messageQueue.push(message)

            if (createdSocket.messageQueue.length > 0) {
                for (let counter = 0; counter < createdSocket.messageQueue.length; counter++) {
                    socket.send(createdSocket.messageQueue[counter])
                }
            }

            createdSocket.messageQueue.length = 0
            break;
        case 2:// CLOSING
        case 3:// CLOSED
            createdSocket.messageQueue.length = 0
            console.error('Trying to send a message while in the CLOSING or CLOSED state')
            break;
    }
}

export type LoginPayload = {
    username: string,
    password?: string | KeyWrapper,
    loginToken?: Uint8Array
    loginType: Authentication.LoginType | null
    loginMethod?: Authentication.LoginMethod,
    v2TwoFactorToken?: string
    resumeSessionOnly?: boolean
    givenSessionToken?: string
}

export enum UserType {
    normal = "normal",
    onsiteSso = "onsite_sso",
    cloudSso = "cloud_sso"
}

export type SessionParams = {
    accountUid: Uint8Array
    username: string
    sessionToken: string
    sessionTokenType: Authentication.SessionTokenType
    dataKey: Uint8Array
    privateKey: Uint8Array
    eccPrivateKey?: Uint8Array
    eccPublicKey?: Uint8Array
    enterpriseEccPublicKey?: Uint8Array
    clientKey: Uint8Array
    userType: UserType
    ssoLogoutUrl: string
    ssoSessionId: string
    messageSessionUid: Uint8Array
}

export type EncryptionKeys = {
    dataKey: Uint8Array;
    privateKey: Uint8Array;
    eccPrivateKey: Uint8Array;
}

export class Auth {
    ssoLogoutUrl: string = ''
    userType: UserType = UserType.normal
    ssoSessionId: string = ''
    dataKey?: Uint8Array;
    privateKey?: Uint8Array;
    eccPrivateKey?: Uint8Array;
    eccPublicKey?: Uint8Array;
    enterpriseEccPublicKey?: Uint8Array;
    private _accountUid?: Uint8Array;
    private _sessionToken: string = '';
    private _sessionTokenType?: Authentication.SessionTokenType;
    private _username: string = '';
    private endpoint: KeeperEndpoint;
    private managedCompanyId?: number;
    private messageSessionUid: Uint8Array;
    options: ClientConfigurationInternal;
    private socket?: SocketListener;
    public clientKey?: Uint8Array;
    private accountSummary?: IAccountSummaryElements;

    constructor(options: ClientConfiguration) {
        if (options.deviceConfig && options.deviceToken) {
            throw new Error('Both loginV2 and loginV3 token strategies supplied')
        }

        this.options = options as ClientConfigurationInternal

        if (!this.options.deviceConfig) {
            this.options.deviceConfig = { }
        }

        if (!this.options.sessionStorage) {
            this.options.sessionStorage = {
                lastUsername: undefined,
                getCloneCode: () => Promise.resolve(null),
                saveCloneCode: () => new Promise((res, rej) => {}),
                getSessionParameters: () => Promise.resolve(null),
                saveSessionParameters: () => Promise.resolve()
            }
        }

        this.endpoint = new KeeperEndpoint(this.options);
        this.endpoint.clientVersion = this.options.clientVersion || "c14.0.0";
        this.messageSessionUid = generateUidBytes()
    }

    get _endpoint(): KeeperEndpoint {
        return this.endpoint;
    }

    get accountUid(): Uint8Array | undefined {
        return this._accountUid;
    }

    get clientVersion(): string {
        return this.endpoint.clientVersion;
    }

    get sessionToken(): string {
        return this._sessionToken;
    }

    get sessionTokenType(): Authentication.SessionTokenType | undefined {
        return this._sessionTokenType
    }

    get username(): string {
        return this._username;
    }

    getMessageSessionUid(): Uint8Array {
        return this.messageSessionUid;
    }

    async idpLogout() {
        if (!this.options.authUI3?.idpLogout) {
            throw Error('authUI3 is not configured')
        }
        if (this.userType == UserType.cloudSso) {
            const payload = await this.endpoint.prepareSsoPayload(this.messageSessionUid, this.username, this.ssoSessionId)

            const params = new URLSearchParams({
                'payload': payload,
            })

            const url = `${this.ssoLogoutUrl}?${String(params)}`

            try {
                await this.options.authUI3.idpLogout(url);
            } catch (e) {
                console.log('Logout errored out: ' + e)
            }

        } else if (this.userType == UserType.onsiteSso) {
            const params = new URLSearchParams({
                'embedded': 'true',
                'username': this.username,
                'session_id': this.ssoSessionId,
                'dest': 'vault'
            })

            const url = `${this.ssoLogoutUrl}?${String(params)}`

            try {
                await this.options.authUI3.idpLogout(url);
            } catch (e) {
                console.log('Logout errored out: ' + e)
            }
        }
    }

    async logout() {
        platform.unloadKeys()
        await this.executeRestAction(logoutV3Message())
        await this.idpLogout()
    }

    connect() {
        // When connecting to govcloud, remove the govcloud subdomain. There is no list of urls that do/don't require the govcloud subdomain, so for now do this.
        const url = `wss://push.services.${this.options.host.replace('govcloud.', '')}/wss_open_connection`
        const getConnectionRequest = (messageSessionUid) => this.endpoint.getPushConnectionRequest(messageSessionUid)

        this.socket = new SocketListener(url, this.messageSessionUid, getConnectionRequest)
        console.log("Socket connected")
        this.onCloseMessage((closeReason: CloseReason) => {
            if (this.options.onCommandFailure) {
                this.options.onCommandFailure({
                    result_code: closeReason.code.toString(),
                    message: closeReason.reason.close_reason
                })
            }
        })
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect()
            delete this.socket
        }
    }

    /**
     * useAlternate is to pass to the next function to use an alternate method, for testing a different path.
     */
    async loginV3(
        {
            username = '',
            password = undefined,
            loginToken = undefined,
            loginType = Authentication.LoginType.NORMAL,
            loginMethod = Authentication.LoginMethod.EXISTING_ACCOUNT,
            v2TwoFactorToken = undefined,
            resumeSessionOnly = false,
            givenSessionToken = undefined,
        }: LoginPayload
    ) {
        this._username = username || this.options.sessionStorage?.lastUsername || ''

        let wrappedPassword: KeyWrapper | undefined;

        if (password) {
            if (typeof password === 'string') {
                wrappedPassword = wrapPassword(password)
            }
            else
                wrappedPassword = password
        }

        let needUserName = false
        let isAlternate = false

        const handleError = (resultCode: string, loginResponse: NN<Authentication.ILoginResponse>, error: KeeperError) => {
            const errorMessage = chooseErrorMessage(loginResponse.loginState)
            if (this.options.onCommandFailure) {
                this.options.onCommandFailure({
                    result_code: resultCode,
                    message: errorMessage,
                    error: error.message,
                })
            } else {
                throw error;
            }
        };

        while (true) {

            if (!this.options.deviceConfig.deviceToken) {
                await this.endpoint.registerDevice()
            }

            if (!this.socket || !this.socket.getIsConnected()) {
                this.connect()
            }

            const startLoginRequest: IStartLoginRequest = {
                clientVersion: this.endpoint.clientVersion,
                encryptedDeviceToken: this.options.deviceConfig.deviceToken ?? null,
                messageSessionUid: this.messageSessionUid,
                loginMethod: loginMethod,
                cloneCode: await this.options.sessionStorage?.getCloneCode(this.options.host as KeeperEnvironment, this._username),
                v2TwoFactorToken: v2TwoFactorToken
            }
            if (loginType !== LoginType.NORMAL && !!loginType) {
                startLoginRequest.loginType = loginType
                loginType = null
                if (startLoginRequest.loginType == LoginType.ALTERNATE) {
                    isAlternate = true
                }
            }
            if (loginToken) {
                startLoginRequest.encryptedLoginToken = loginToken
            }
            if (needUserName || !this.options.useSessionResumption || isAlternate || username) {
                startLoginRequest.username = this._username
                needUserName = false
            }

            var loginResponse: NN<Authentication.ILoginResponse>;
            if (givenSessionToken){
                this._sessionToken = givenSessionToken
                try{
                    loginResponse = await this.executeRest(startLoginMessageFromSessionToken(startLoginRequest))
                } catch(e: any){
                    console.error('Fails session token login. failed_login_from_existing_session_token')
                    throw(e)
                }
            } else {
                loginResponse = await this.executeRest(startLoginMessage(startLoginRequest))
            }

            if (loginResponse.cloneCode && loginResponse.cloneCode.length > 0) {
                this.options.sessionStorage?.saveCloneCode(this.options.host as KeeperEnvironment, this._username, loginResponse.cloneCode)
            }
            if (resumeSessionOnly && loginResponse && (loginResponse.loginState != Authentication.LoginState.LOGGED_IN)) {
                return {
                    result: 'notLoggedin'
                }
            }
            console.log(loginResponse)
            console.log("login state =", loginResponse.loginState);

            switch (loginResponse.loginState) {
                case Authentication.LoginState.ACCOUNT_LOCKED:
                case Authentication.LoginState.INVALID_LOGINSTATE:
                case Authentication.LoginState.LOGGED_OUT:
                case Authentication.LoginState.AFTER_CLOUD_SSO_LOGIN:
                case Authentication.LoginState.LOGIN_TOKEN_EXPIRED:
                case Authentication.LoginState.DEVICE_ACCOUNT_LOCKED:
                case Authentication.LoginState.DEVICE_LOCKED:
                    handleError('generic_error', loginResponse, new Error(`Unable to login, login state = ${loginResponse.loginState}`))
                    return
                case Authentication.LoginState.REQUIRES_ACCOUNT_CREATION:
                    if (this.userType === UserType.cloudSso) {
                        await this.createSsoUser(loginResponse.encryptedLoginToken)
                    } else {
                        if (!wrappedPassword) {
                            throw Error('Password must be assigned before user creation')
                        }
                        await this.createUser(this._username, wrappedPassword)
                    }
                    break;
                case Authentication.LoginState.UPGRADE:
                    handleError('generic_error', loginResponse, new Error(`Unable to login, login state = ${loginResponse.loginState}`))
                    return;
                case Authentication.LoginState.REQUIRES_USERNAME:
                    if (!this._username) {
                        handleError('generic_error', loginResponse, new Error(`No username supplied, login state = ${loginResponse.loginState}`));
                        return
                    }
                    needUserName = true
                    break;
                case Authentication.LoginState.DEVICE_APPROVAL_REQUIRED:
                case Authentication.LoginState.REQUIRES_DEVICE_ENCRYPTED_DATA_KEY:
                    if (givenSessionToken) return { result: 'notLoggedin' }
                    try {
                        loginToken = await this.verifyDevice(username, loginResponse.encryptedLoginToken, loginResponse.loginState == Authentication.LoginState.REQUIRES_DEVICE_ENCRYPTED_DATA_KEY)
                    } catch (e: any) {
                        handleError('auth_failed', loginResponse, e)
                        return
                    }
                    break;
                case Authentication.LoginState.LICENSE_EXPIRED:
                    handleError('license_expired', loginResponse, new Error(loginResponse.message))
                    return;
                case Authentication.LoginState.REGION_REDIRECT:
                    // TODO: put region_redirect in its own loop since
                    // its unique to the other states.
                    this.options.host = loginResponse.stateSpecificValue
                    loginToken = undefined
                    if (this.options.onRegionChanged) {
                        this.options.onRegionChanged(loginResponse.stateSpecificValue)
                    }
                    // Current socket no longer pointing to the right region
                    this.disconnect()
                    break;
                case Authentication.LoginState.REDIRECT_CLOUD_SSO:
                    console.log("Cloud SSO Connect login");
                    this.ssoLogoutUrl = loginResponse.url.replace('login', 'logout')
                    this.userType = UserType.cloudSso
                    let payload = await this._endpoint.prepareSsoPayload(this.messageSessionUid)
                    let cloudSsoLoginUrl = loginResponse.url + "?payload=" + payload;
                    if (this.options.authUI3?.redirectCallback) {
                        await this.options.authUI3.redirectCallback(cloudSsoLoginUrl)
                        return
                    } else if (this.options.authUI3?.ssoLogin) {
                        const token = await this.options.authUI3.ssoLogin(cloudSsoLoginUrl)
                        const cloudResp = await this.endpoint.decryptCloudSsoResponse(token)
                        console.log(cloudResp)
                        this._username = cloudResp.email
                        loginToken = cloudResp.encryptedLoginToken
                        loginMethod = LoginMethod.AFTER_SSO
                    }
                    break;
                case Authentication.LoginState.REDIRECT_ONSITE_SSO:
                    console.log("SSO Connect login");
                    this.ssoLogoutUrl = loginResponse.url.replace('login', 'logout')
                    this.userType = UserType.onsiteSso

                    let onsitePublicKey = await this._endpoint.getOnsitePublicKey()
                    let onsiteSsoLoginUrl = loginResponse.url + '?embedded&key=' + onsitePublicKey

                    if (this.options.authUI3?.redirectCallback) {
                        await this.options.authUI3.redirectCallback(onsiteSsoLoginUrl)
                        return
                    } else if (this.options.authUI3?.ssoLogin) {
                        const onsiteResp = await this.options.authUI3.ssoLogin(onsiteSsoLoginUrl)
                        console.log(onsiteResp)
                        this._username = onsiteResp.email
                        wrappedPassword = wrapPassword(onsiteResp.password)
                        loginType = LoginType.SSO
                        loginMethod = LoginMethod.AFTER_SSO
                    }
                    break;
                case Authentication.LoginState.REQUIRES_2FA:
                    try{
                        loginToken = await this.handleTwoFactor(loginResponse)
                    } catch(e: any){
                        if (e?.message && e.message == 'push_declined'){
                            handleError(e.message, loginResponse, e)
                        }
                    }
                    break
                case Authentication.LoginState.REQUIRES_AUTH_HASH:
                    // TODO: loop in authHashLogin until successful or get into
                    // some other state other than Authentication.LoginState.REQUIRES_AUTH_HASH
                    if (!wrappedPassword && this.options.authUI3?.getPassword) {
                        password = await this.options.authUI3.getPassword()
                        if (password) {
                            if (typeof password === 'string') {
                                wrappedPassword = wrapPassword(password)
                            }
                            else
                                wrappedPassword = password
                        }
                    }
                    if (!wrappedPassword) {
                        throw new Error('User password required and not provided')
                    }

                    try {
                        await this.authHashLogin(loginResponse, username, wrappedPassword, isAlternate)
                        return;
                    } catch (e: any) {
                        wrappedPassword = undefined
                        handleError('auth_failed', loginResponse, e)
                        break;
                    }
                case Authentication.LoginState.LOGGED_IN:
                    try {
                        await this.loginSuccess(loginResponse, undefined)
                        console.log("Exiting on loginState = LOGGED_IN");
                        return;
                    } catch (e) {
                        console.log('Error in Authentication.LoginState.LOGGED_IN: ', e)
                        return;
                    }
            }
        }
    }

    /**
     * The MV3 browser extension runs in a service worker that shuts down every 5 minutes.
     * This rehydrates the Auth class and re-opens our socket with the session parameters.
     */
    async continueSession() {
        if (!this.options.sessionStorage) {
            throw new Error('Missing configuration option to get session parameters')
        }

        const sessionParams = await this.options.sessionStorage.getSessionParameters()
        if (!sessionParams) {
            throw new Error('No session to resume')
        }

        this.messageSessionUid = sessionParams.messageSessionUid
        this._username = sessionParams.username
        this.dataKey = sessionParams.dataKey
        this.clientKey = sessionParams.clientKey
        this.privateKey = sessionParams.privateKey
        this.eccPrivateKey = sessionParams.eccPrivateKey
        this.eccPublicKey = sessionParams.eccPublicKey
        this.enterpriseEccPublicKey = sessionParams.enterpriseEccPublicKey
        this.ssoLogoutUrl = sessionParams.ssoLogoutUrl
        this.ssoSessionId = sessionParams.ssoSessionId
        this.userType = sessionParams.userType

        if (!this.socket || !this.socket.getIsConnected()) {
            this.connect()
        }

        this.setLoginParameters(sessionParams.sessionToken, sessionParams.sessionTokenType, sessionParams.accountUid)
    }

    private getSessionParameters(): Partial<SessionParams> {
        return {
            accountUid: this._accountUid,
            username: this._username,
            sessionToken: this._sessionToken,
            sessionTokenType: this._sessionTokenType,
            dataKey: this.dataKey,
            privateKey: this.privateKey,
            eccPrivateKey: this.eccPrivateKey,
            eccPublicKey: this.eccPublicKey,
            enterpriseEccPublicKey: this.enterpriseEccPublicKey,
            clientKey: this.clientKey,
            userType: this.userType,
            ssoLogoutUrl: this.ssoLogoutUrl,
            ssoSessionId: this.ssoSessionId,
            messageSessionUid: this.messageSessionUid
        }
    }

    async getSsoProvider(ssoDomain: string, locale?: string) {
        let domainRequest: ISsoServiceProviderRequest = {
            name: ssoDomain.trim(),
            locale: locale,
            clientVersion: this.endpoint.clientVersion,
        }
        const domainResponse = await this.executeRest(ssoServiceProviderRequestMessage(domainRequest))
        const params = domainResponse.isCloud
            ? '?payload=' + await this._endpoint.prepareSsoPayload(this.messageSessionUid)
            : '?embedded&key=' + await this._endpoint.getOnsitePublicKey()

        this.userType = domainResponse.isCloud ? UserType.cloudSso : UserType.onsiteSso
        this.ssoLogoutUrl = domainResponse.spUrl.replace('login', 'logout')

        return {
            url: domainResponse.spUrl + params,
            name: domainResponse.name,
        }
    }

    verifyDevice(username: string, loginToken: Uint8Array, isCloud: boolean = false): Promise<Uint8Array> {
        return new Promise<Uint8Array>((resolve, reject) => {
            if (!this.options.authUI3) {
                reject(new Error('No authUI3 provided. authUI3 required to verify devices'))
                return
            }

            let emailSent = false
            let tfaExpiration = TwoFactorExpiration.TWO_FA_EXP_IMMEDIATELY
            const deviceConfig = this.options.deviceConfig
            let channels: DeviceApprovalChannel[]
            if (!isCloud) {
                channels = [
                    {
                        channel: DeviceVerificationMethods.Email,
                        sendApprovalRequest: async () => {
                            await this.executeRestAction(requestDeviceVerificationMessage({
                                username: username,
                                verificationChannel: emailSent ? 'email_resend' : 'email',
                                encryptedDeviceToken: deviceConfig.deviceToken,
                                clientVersion: this.endpoint.clientVersion,
                                messageSessionUid: this.messageSessionUid
                            }))
                            emailSent = true
                        },
                        validateCode: async (code) => {
                            await this.executeRestAction(validateDeviceVerificationCodeMessage({
                                verificationCode: code,
                                username: username,
                            }))
                            resumeWithToken(loginToken)
                        }
                    },
                    {
                        channel: DeviceVerificationMethods.KeeperPush,
                        sendApprovalRequest: async () => {
                            await this.executeRestAction(twoFactorSend2FAPushMessage({
                                encryptedLoginToken: loginToken,
                                pushType: TwoFactorPushType.TWO_FA_PUSH_KEEPER
                            }))
                        }
                    },
                    {
                        channel: DeviceVerificationMethods.TFA,
                        sendApprovalRequest: async () => {
                            await this.executeRestAction(twoFactorSend2FAPushMessage({
                                encryptedLoginToken: loginToken,
                            }))
                        },
                        validateCode: async (code) => {
                            const twoFactorValidateMsg = twoFactorValidateMessage({
                                encryptedLoginToken: loginToken,
                                value: code,
                                expireIn: tfaExpiration
                            })
                            const twoFactorValidateResp = await this.executeRest(twoFactorValidateMsg)
                            if (twoFactorValidateResp.encryptedLoginToken) {
                                const wssRs: Record<string, any> = {
                                    event: 'received_totp',
                                    encryptedLoginToken: platform.bytesToBase64(twoFactorValidateResp.encryptedLoginToken)
                                }
                                processPushNotification(wssRs)
                            }
                        },
                        setExpiration: expiration => {
                            tfaExpiration = expiration
                        }
                    }
                ];
            } else {
                channels = [
                    {
                        channel: DeviceVerificationMethods.KeeperPush,
                        sendApprovalRequest: async () => {
                            await this.executeRestAction(twoFactorSend2FAPushMessage({
                                encryptedLoginToken: loginToken,
                                pushType: TwoFactorPushType.TWO_FA_PUSH_KEEPER
                            }))
                        }
                    },
                    {
                        channel: DeviceVerificationMethods.AdminApproval,
                        sendApprovalRequest: async () => {
                            await this.executeRestAction(requestDeviceAdminApprovalMessage({
                                username: username,
                                verificationChannel: emailSent ? 'email_resend' : 'email',
                                encryptedDeviceToken: deviceConfig.deviceToken,
                                clientVersion: this.endpoint.clientVersion,
                                messageSessionUid: this.messageSessionUid
                            }))
                        }
                    }
                ]
            }

            let done = false
            const resumeWithToken = (token: Uint8Array) => {
                done = true
                resolve(token)
            }
            const rejectWithError = (error: Error) => {
                done = true
                reject(error)
            }

            const processPushNotification = (wssRs: Record<string, any>) => {
                if (wssRs.event === 'received_totp') {
                    const token = wssRs.encryptedLoginToken ? normal64Bytes(wssRs.encryptedLoginToken) : loginToken
                    resumeWithToken(token)
                } else if (wssRs.message === 'device_approved') {
                    if (wssRs.approved) {
                        resumeWithToken(loginToken)
                    } else {
                        rejectWithError(new Error('Rejected'))
                    }
                } else if (wssRs.command === 'device_verified') {
                    if (this.options.onDeviceVerified) {
                        this.options.onDeviceVerified(true)
                    }
                    resumeWithToken(loginToken)
                }
            }

            // response from the client true - try again, false - cancel
            this.options.authUI3.waitForDeviceApproval(channels, isCloud)
                .then((ok) => {
                    if (ok) {
                        resumeWithToken(loginToken)
                    } else {
                        rejectWithError(new Error('Canceled'))
                    }
                })
                .catch(reason => rejectWithError(reason))

            // receive push notification
            ;(async () => {
                if (!this.socket) {
                    return
                }
                while (!done) {
                    const pushMessage = await this.socket.getPushMessage()
                    const wssClientResponse = await this.endpoint.decryptPushMessage(pushMessage)
                    if (!done) {
                        const wssRs = JSON.parse(wssClientResponse.message)
                        console.log(wssRs)
                        processPushNotification(wssRs)
                    }
                }
            })();
        })
    }

    private handleTwoFactor(loginResponse: Authentication.ILoginResponse): Promise<Uint8Array> {
        return new Promise<Uint8Array>((resolve, reject) => {
            const responseChannels = loginResponse.channels
            if (!responseChannels) {
                reject(new Error('Channels not provided by API'))
                return
            }

            const loginToken = loginResponse.encryptedLoginToken
            if (!loginToken) {
                reject(new Error('Login token not provided by API'))
                return
            }

            let done = false
            let twoFactorWaitCancel = resolvablePromise();
            const resumeWithToken = (token: Uint8Array) => {
                done = true
                twoFactorWaitCancel.resolve()
                resolve(token)
            }
            const rejectWithError = (error: Error) => {
                done = true
                twoFactorWaitCancel.resolve()
                reject(error)
            }

            let tfaExpiration = TwoFactorExpiration.TWO_FA_EXP_IMMEDIATELY
            const submitCode = async (channel: Authentication.TwoFactorChannelType, code: string) => {
                const channelInfo = responseChannels.find(x => x.channelType === channel)
                let valueType: Authentication.TwoFactorValueType | undefined
                switch (channelInfo?.channelType) {
                    case Authentication.TwoFactorChannelType.TWO_FA_CT_DNA:
                        valueType = Authentication.TwoFactorValueType.TWO_FA_CODE_DNA
                        break
                    case Authentication.TwoFactorChannelType.TWO_FA_CT_DUO:
                        valueType = Authentication.TwoFactorValueType.TWO_FA_CODE_DUO
                        break
                    case Authentication.TwoFactorChannelType.TWO_FA_CT_SMS:
                        valueType = Authentication.TwoFactorValueType.TWO_FA_CODE_SMS
                        break
                    case Authentication.TwoFactorChannelType.TWO_FA_CT_TOTP:
                        valueType = Authentication.TwoFactorValueType.TWO_FA_CODE_TOTP
                        break
                    case Authentication.TwoFactorChannelType.TWO_FA_CT_RSA:
                        valueType = Authentication.TwoFactorValueType.TWO_FA_CODE_RSA
                        break
                    case Authentication.TwoFactorChannelType.TWO_FA_CT_U2F:
                        valueType = Authentication.TwoFactorValueType.TWO_FA_RESP_U2F
                        break
                    case Authentication.TwoFactorChannelType.TWO_FA_CT_WEBAUTHN:
                        valueType = Authentication.TwoFactorValueType.TWO_FA_RESP_WEBAUTHN
                        break
                    default:
                        valueType = undefined
                        break
                }
                const twoFactorValidateMsg = twoFactorValidateMessage({
                    channelUid: channelInfo ? channelInfo.channelUid : undefined,
                    encryptedLoginToken: loginToken,
                    value: code,
                    expireIn: tfaExpiration,
                    valueType: valueType,
                })
                const twoFactorValidateResp = await this.executeRest(twoFactorValidateMsg)
                if (twoFactorValidateResp.encryptedLoginToken) {
                    resumeWithToken(twoFactorValidateResp.encryptedLoginToken)
                }
            }

            let lastPushChannel = TwoFactorChannelType.TWO_FA_CT_NONE
            const submitPush = async (channel: TwoFactorChannelType, pushType: TwoFactorPushType) => {
                const sendPushRequest: ITwoFactorSendPushRequest = {
                    encryptedLoginToken: loginResponse.encryptedLoginToken,
                    pushType: pushType,
                    expireIn: tfaExpiration
                }
                await this.executeRestAction(twoFactorSend2FAPushMessage(sendPushRequest))
                lastPushChannel = channel
            }

            const channels: TwoFactorChannelData[] = responseChannels
                .map((ch) => {
                    const tfachannelData: TwoFactorChannelData = {
                        channel: ch,
                        setExpiration: (exp) => {
                            tfaExpiration = exp
                        },
                        sendCode: async (code) => {
                            await submitCode(ch.channelType!, code)
                        }
                    }
                    switch (ch.channelType) {
                        case TwoFactorChannelType.TWO_FA_CT_U2F:
                        case TwoFactorChannelType.TWO_FA_CT_WEBAUTHN:
                            // add support for security key as push
                            break;
                        case TwoFactorChannelType.TWO_FA_CT_TOTP:
                        case TwoFactorChannelType.TWO_FA_CT_RSA:
                            break
                        case TwoFactorChannelType.TWO_FA_CT_SMS:
                            tfachannelData.availablePushes = [TwoFactorPushType.TWO_FA_PUSH_SMS]
                            break
                        case TwoFactorChannelType.TWO_FA_CT_DNA:
                            tfachannelData.availablePushes = [TwoFactorPushType.TWO_FA_PUSH_DNA]
                            break
                        case TwoFactorChannelType.TWO_FA_CT_KEEPER:
                        case TwoFactorChannelType.TWO_FA_CT_DUO:
                            if (ch.capabilities) {
                                tfachannelData.availablePushes = ch.capabilities
                                    .map(cap => {
                                        switch (cap) {
                                            case 'push':
                                                return TwoFactorPushType.TWO_FA_PUSH_DUO_PUSH
                                            case 'sms':
                                                return TwoFactorPushType.TWO_FA_PUSH_DUO_TEXT
                                            case 'phone':
                                                return TwoFactorPushType.TWO_FA_PUSH_DUO_CALL
                                            default:
                                                return undefined
                                        }
                                    }).filter(cap => !!cap).map(cap => cap!)
                            }
                            break
                    }
                    if (tfachannelData.availablePushes) {
                        tfachannelData.sendPush = async (pushType: TwoFactorPushType) => {
                            submitPush(ch.channelType!, pushType)
                        }
                    }
                    return tfachannelData
                }).filter((chd: TwoFactorChannelData | undefined) => !!chd).map(chd => chd!)

            const processPushNotification = (wssRs: Record<string, any>) => {
                if (wssRs.event === 'received_totp') {
                    if (wssRs.encryptedLoginToken) {
                        const token = normal64Bytes(wssRs.encryptedLoginToken)
                        resumeWithToken(token)
                    } else if (wssRs.passcode) {
                        (async () => {
                            await submitCode(lastPushChannel, wssRs.passcode)
                        })()
                    } else {
                        rejectWithError(new Error('push_declined'))
                    }
                }
            }

            this.options.authUI3?.waitForTwoFactorCode(channels, twoFactorWaitCancel.promise)
                .then(ok => {
                    if (ok) {
                        resumeWithToken(loginToken)
                    } else {
                        rejectWithError(new Error('Canceled'))
                    }
                })
                .catch(reason => rejectWithError(reason))

            // receive push notification
            ;(async () => {
                if (!this.socket) {
                    return
                }
                while (!done) {
                    const pushMessage = await this.socket.getPushMessage()
                    const wssClientResponse = await this.endpoint.decryptPushMessage(pushMessage)
                    if (!done) {
                        const wssRs = JSON.parse(wssClientResponse.message)
                        console.log(wssRs)
                        processPushNotification(wssRs)
                    }
                }
            })();
        })
    }

    async authHashLogin(loginResponse: NN<Authentication.ILoginResponse>, username: string, password: KeyWrapper, useAlternate: boolean = false) {
        // TODO test for account transfer and account recovery
        const salt = useAlternate ? loginResponse.salt.find(s => s.name === 'alternate') : loginResponse.salt[0]
        if (!salt?.salt || !salt?.iterations) {
            throw new Error('Salt missing from API response')
        }

        this.options.salt = salt.salt
        this.options.iterations = salt.iterations

        const authHashKey = await platform.deriveKey(password, salt.salt, salt.iterations);
        let authHash = await platform.calcAuthVerifier(authHashKey);

        const loginMsg = validateAuthHashMessage({
            authResponse: authHash,
            encryptedLoginToken: loginResponse.encryptedLoginToken
        })
        const loginResp = await this.executeRest(loginMsg)
        console.log(loginResp)
        if (loginResp.cloneCode && loginResp.cloneCode.length > 0) {
            await this.options.sessionStorage?.saveCloneCode(this.options.host as KeeperEnvironment, this._username, loginResp.cloneCode)
        }
        await this.loginSuccess(loginResp, password, salt)
    }

    async loginSuccess(loginResponse: NN<Authentication.ILoginResponse>, password?: KeyWrapper, salt: Authentication.ISalt | undefined = undefined) {
        this._username = loginResponse.primaryUsername || this._username
        this.setLoginParameters(webSafe64FromBytes(loginResponse.encryptedSessionToken), loginResponse.sessionTokenType ?? undefined, loginResponse.accountUid)
        switch (loginResponse.encryptedDataKeyType) {
            case Authentication.EncryptedDataKeyType.BY_DEVICE_PUBLIC_KEY:
                if (!this.options.deviceConfig.privateKey) {
                    throw Error('Private key is missing from the device config')
                }
                this.dataKey = await platform.privateDecryptEC(loginResponse.encryptedDataKey, this.options.deviceConfig.privateKey, this.options.deviceConfig.publicKey)
                break;
            case Authentication.EncryptedDataKeyType.BY_PASSWORD:
                if (!password) {
                    throw Error('Password is missing, unable to continue')
                }
                this.dataKey = await decryptEncryptionParams(password, loginResponse.encryptedDataKey);
                break;
            case Authentication.EncryptedDataKeyType.BY_ALTERNATE:
                if (!password || !salt) {
                    throw Error('Password or salt is missing, unable to continue')
                }
                if (salt) {
                    const encKey = await platform.deriveKeyV2('data_key', password, salt.salt!, salt.iterations!)
                    this.dataKey = await platform.aesGcmDecrypt(loginResponse.encryptedDataKey, encKey)
                }
                break;
            case Authentication.EncryptedDataKeyType.NO_KEY:
            case Authentication.EncryptedDataKeyType.BY_BIO:
                throw new Error(`Data Key type ${loginResponse.encryptedDataKeyType} decryption not implemented`)
        }

        await this.loadAccountSummary()

        let encryptedPrivateKey: Uint8Array | undefined
        let encryptedEccPrivateKey: Uint8Array | undefined
        if (this.options.kvs) {
            const encryptedPrivateKeyString = this.options.kvs.getValue(`${this._username}/private_key`)
            if (encryptedPrivateKeyString) {
                encryptedPrivateKey = platform.base64ToBytes(encryptedPrivateKeyString)
            }
            const encryptedEccPrivateKeyString = this.options.kvs.getValue(`${this._username}/ecc_private_key`)
            if (encryptedEccPrivateKeyString) {
                encryptedEccPrivateKey = platform.base64ToBytes(encryptedEccPrivateKeyString)
            }
        }
        if (!encryptedPrivateKey || !encryptedEccPrivateKey) {
            encryptedPrivateKey = this.accountSummary?.keysInfo?.encryptedPrivateKey || undefined
            encryptedEccPrivateKey = this.accountSummary?.keysInfo?.encryptedEccPrivateKey || undefined
            if (this.options.kvs) {
                if (encryptedPrivateKey) {
                    this.options.kvs.saveValue(`${this._username}/private_key`, platform.bytesToBase64(encryptedPrivateKey))
                }
                if (encryptedEccPrivateKey) {
                    this.options.kvs.saveValue(`${this._username}/ecc_private_key`, platform.bytesToBase64(encryptedEccPrivateKey))
                }
            }
        }
        if (!this.dataKey) {
            throw Error('Data Key is missing')
        }
        if (encryptedPrivateKey) {
            this.privateKey = await platform.aesCbcDecrypt(encryptedPrivateKey, this.dataKey, true)
        }
        if (encryptedEccPrivateKey) {
            this.eccPrivateKey = await platform.aesGcmDecrypt(encryptedEccPrivateKey, this.dataKey)
            this.eccPublicKey = this.accountSummary?.keysInfo?.eccPublicKey || undefined
        }

        if (this.accountSummary?.clientKey) {
            this.clientKey = await platform.aesCbcDecrypt(this.accountSummary.clientKey, this.dataKey, true)
        }

        if (this.options.sessionStorage) {
            this.options.sessionStorage.saveSessionParameters(this.getSessionParameters())
        }
    }

    async loadAccountSummary() {
        this.accountSummary = await this.executeRest(accountSummaryMessage({
            summaryVersion: 1
        }));
    }

    // async executeCommand<Command extends KeeperCommand>(command: Command): Promise<Command["response"]> {
    //     if (!command.username) {
    //         command.username = this._username;
    //     }
    //     if (command instanceof AuthorizedCommand) {
    //         command.device_id = "JS Keeper API";
    //         command.session_token = this._sessionToken;
    //     }
    //     return this.endpoint.executeV2Command(command);
    // }

    async executeRest<TIn, TOut>(message: RestOutMessage<TOut> | RestMessage<TIn, TOut>): Promise<TOut> {
        return this.endpoint.executeRest(message, this._sessionToken);
    }

    async executeRestCommand<Request, Response>(command: RestCommand<Request, Response>): Promise<Response> {
        if (!command.baseRequest.username) {
            command.baseRequest.username = this._username;
        }
        if (command.authorization) {
            command.authorization.device_id = 'JS Keeper API'
            command.authorization.session_token = this.sessionToken
        }
        return this.endpoint.executeRestCommand(command);
    }

    async executeRestAction<TIn, TOut>(message: RestInMessage<TIn> | RestActionMessage): Promise<void> {
        return this.endpoint.executeRestAction(message, this._sessionToken);
    }

    async get(path: string) {
        return this.endpoint.get(path)
    }

    setLoginParameters(sessionToken: string, sessionTokenType?: Authentication.SessionTokenType, accountUid?: Uint8Array) {
        this._sessionToken = sessionToken;
        this._sessionTokenType = sessionTokenType
        this._accountUid = accountUid;
        if (!this.socket) {
            throw new Error('No socket available')
        } 
        if (this.socket.getIsConnected()) {
            this.socket.registerLogin(this._sessionToken)
        }
        this.socket.onOpen(() => {
            this.socket?.registerLogin(this._sessionToken)
        })
    }

    async registerDevice() {
        await this.endpoint.registerDevice()
    }

    onClose(callback: () => void): void {
        if (!this.socket) {
            throw new Error('No socket available')
        }
        this.socket.onClose(callback)
    }

    onError(callback: () => void): void {
        if (!this.socket) {
            throw new Error('No socket available')
        }
        this.socket.onError(callback)
    }

    onPushMessage(callback: (data: any) => void): void {
        if (!this.socket) {
            throw new Error('No socket available')
        }
        this.socket.onPushMessage(callback)
    }

    onCloseMessage(callback: (data:any) => void): void {
        if (!this.socket) {
            throw new Error('No socket available')
        }
        this.socket.onCloseMessage(callback)
    }

    async getPushMessage(): Promise<any> {
        if (!this.socket) {
            throw new Error('No socket available')
        }
        const pushMessage = await this.socket.getPushMessage()
        const wssClientResponse = await this.endpoint.decryptPushMessage(pushMessage)
        console.log(wssClientResponse.message)
        return JSON.parse(wssClientResponse.message)
    }

    private async createUserRequest(dataKey: Uint8Array): Promise<Authentication.ICreateUserRequest> {
        const rsaKeys = await platform.generateRSAKeyPair()
        const rsaEncryptedPrivateKey = await platform.aesCbcEncrypt(rsaKeys.privateKey, dataKey, true)

        const ecKeys = await platform.generateECKeyPair()
        const eccEncryptedPrivateKey = await platform.aesGcmEncrypt(ecKeys.privateKey, dataKey)

        const encryptedClientKey = await platform.aesCbcEncrypt(generateEncryptionKey(), dataKey, true)

        return {
            rsaPublicKey: rsaKeys.publicKey,
            rsaEncryptedPrivateKey: rsaEncryptedPrivateKey,
            eccPublicKey: ecKeys.publicKey,
            eccEncryptedPrivateKey: eccEncryptedPrivateKey,
            encryptedDeviceToken: this.options.deviceConfig.deviceToken,
            encryptedClientKey: encryptedClientKey,
            clientVersion: this.options.clientVersion,
        }
    }

    public async createUser(username: string, password: KeyWrapper) {
        const iterations = 100000
        const dataKey = generateEncryptionKey()
        const authVerifier = await createAuthVerifier(password, iterations)
        const encryptionParams = await createEncryptionParams(password, dataKey, iterations)
        const request = await this.createUserRequest(dataKey)
        const regUserMsg = requestCreateUserMessage({
            ...request,
            username: username,
            authVerifier: authVerifier,
            encryptionParams: encryptionParams,
        }, false)
        await this.executeRestAction(regUserMsg)
    }

    private async createSsoUser(loginToken: Uint8Array) {
        if (!this.options.deviceConfig.publicKey) {
            throw Error('Public key is missing')
        }
        const dataKey = generateEncryptionKey()
        const encryptedDeviceDataKey = await platform.publicEncryptEC(dataKey, this.options.deviceConfig.publicKey)
        const request = await this.createUserRequest(dataKey)
        const regUserMsg = requestCreateUserMessage({
            ...request,
            username: this._username,
            encryptedLoginToken: loginToken,
            encryptedDeviceDataKey: encryptedDeviceDataKey
        }, true)
        await this.executeRestAction(regUserMsg)
    }

    public async getEnterpriseECCPublicKey() {
        const resp = await this.executeRest(getEnterprisePublicKeyMessage())
        if (resp.enterpriseECCPublicKey) {
            this.enterpriseEccPublicKey = resp.enterpriseECCPublicKey
        }
    }

    public getKeys(): EncryptionKeys {
        if (!this.dataKey || !this.privateKey || !this.eccPrivateKey) {
            throw Error('Encryption keys are missing')
        }
        return {
            dataKey: this.dataKey,
            privateKey: this.privateKey,
            eccPrivateKey: this.eccPrivateKey
        }
    }

    public setPrimaryUsername(username: string) {
        this._username = username
    }
}

const iterationsToBytes = (iterations: number): Uint8Array => {
    const iterationBytes = new ArrayBuffer(4)
    new DataView(iterationBytes).setUint32(0, iterations)
    const bytes = new Uint8Array(iterationBytes)
    bytes[0] = 1 // version
    return bytes
};

export async function createAuthVerifier(password: KeyWrapper, iterations: number): Promise<Uint8Array> {
    const salt = platform.getRandomBytes(16);
    const authHashKey = await platform.deriveKey(password, salt, iterations);
    return Uint8Array.of(...iterationsToBytes(iterations), ...salt, ...authHashKey)
}

export async function createEncryptionParams(password: KeyWrapper, dataKey: Uint8Array, iterations: number): Promise<Uint8Array> {
    const salt = platform.getRandomBytes(16);
    const authHashKey = await platform.deriveKey(password, salt, iterations);
    const doubledDataKey = Uint8Array.of(...dataKey, ...dataKey)
    const encryptedDoubledKey = await platform.aesCbcEncrypt(doubledDataKey, authHashKey, false)
    return Uint8Array.of(...iterationsToBytes(iterations), ...salt, ...encryptedDoubledKey)
}

async function decryptEncryptionParamsString(password: KeyWrapper, encryptionParams: string): Promise<Uint8Array> {
    return decryptEncryptionParams(password, platform.base64ToBytes(normal64(encryptionParams)))
}

export async function decryptEncryptionParams(password: KeyWrapper, encryptionParams: Uint8Array): Promise<Uint8Array> {
    let corruptedEncryptionParametersMessage = "Corrupted encryption parameters";
    if (encryptionParams[0] !== 1)
        throw new Error(corruptedEncryptionParametersMessage);
    let iterations = (encryptionParams[1] << 16) + (encryptionParams[2] << 8) + encryptionParams[3];
    let saltBytes = encryptionParams.subarray(4, 20);
    let masterKey = await platform.deriveKey(password, saltBytes, iterations);
    let encryptedDoubledDataKey = encryptionParams.subarray(20);
    let doubledDataKey = await platform.aesCbcDecrypt(encryptedDoubledDataKey, masterKey, false);
    for (let i = 0; i < 32; i++) {
        if (doubledDataKey[i] !== doubledDataKey[i + 32]) {
            throw new Error(corruptedEncryptionParametersMessage);
        }
    }
    return doubledDataKey.slice(0, 32);
}
