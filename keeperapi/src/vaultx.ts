import {Auth} from './auth'
import {NN, syncDownMessage} from './restMessages'
import {EncryptionType, KeyStorage, platform} from './platform'
import {Records, Vault} from './proto'
import {formatTimeDiff, webSafe64FromBytes} from './utils'
import CacheStatus = Vault.CacheStatus
import RecordKeyType = Records.RecordKeyType
import IRecordMetaData = Vault.IRecordMetaData
import IRecord = Vault.IRecord
import INonSharedData = Vault.INonSharedData
import ISharedFolder = Vault.ISharedFolder
import ISharedFolderUser = Vault.ISharedFolderUser
import ISharedFolderTeam = Vault.ISharedFolderTeam
import ISharedFolderRecord = Vault.ISharedFolderRecord
import IRecordLink = Vault.IRecordLink
import IUserFolder = Vault.IUserFolder
import ITeam = Vault.ITeam
import ISharedFolderKey = Vault.ISharedFolderKey
import ISharedFolderFolder = Vault.ISharedFolderFolder
import IUserFolderRecord = Vault.IUserFolderRecord;
import ISharedFolderFolderRecord = Vault.ISharedFolderFolderRecord;
import IUserFolderSharedFolder = Vault.IUserFolderSharedFolder
import IReusedPasswords = Vault.IReusedPasswords
import IProfile = Vault.IProfile

export type VaultStorage = KeyStorage & {
    put(data: VaultStorageData): Promise<void>
    getDependencies(uid: string): Dependency[] | undefined
    addDependencies(dependencies: Dependencies): void
    removeDependencies(dependencies: RemovedDependencies): void
    clear(): void
    get<T extends VaultStorageKind>(kind: T, uid?: string): VaultStorageResult<T>
    delete(kind: VaultStorageKind, uid: string): void
}

export type VaultStorageData = DContinuationToken | DRecord | DRecordMetadata | DRecordNonSharedData | DTeam | DSharedFolder | DSharedFolderUser | DSharedFolderTeam | DSharedFolderRecord | DSharedFolderFolder | DUserFolder | DProfile | DReusedPasswords 

export type VaultStorageKind = 'record' | 'metadata' | 'non_shared_data' | 'team' | 'shared_folder' | 'shared_folder_user' | 'shared_folder_team' | 'shared_folder_record' | 'shared_folder_folder' | 'user_folder' | 'profile' | 'continuationToken' | 'reused_passwords'

export type VaultStorageResult<T extends VaultStorageKind> = (
    T extends 'continuationToken' ? DContinuationToken :
    T extends 'record' ? DRecord :
    never
) | undefined

type MappedCounts<Type> = {
  [Property in keyof Type]: number
}

type SyncResponseCounts = MappedCounts<Vault.ISyncDownResponse>

export type SyncResult = {
    started: Date
    username: string
    pageCount: number
    counts: SyncResponseCounts
    totalTime?: string
    networkTime?: string
    error?: string
    continuationToken?: string
    fullSync?: boolean
}

export type DRecord = {
    kind: 'record'
    uid: string
    data: any
    version: number
    revision: number
    shared: boolean
    clientModifiedTime: number
    extra?: any
}

export type DRecordMetadata = {
    kind: 'metadata'
    uid: string
    owner: boolean
    canShare: boolean
    canEdit: boolean
}

export type DTeam = {
    kind: 'team'
    uid: string
    name: string
    restrictEdit: boolean
    restrictShare: boolean
    restrictView: boolean
}

export type DRecordNonSharedData = {
    kind: 'non_shared_data'
    uid: string
    data: {[key: string]: any}
}

export type DSharedFolder = {
    kind: 'shared_folder'
    uid: string
    data: any
    revision: number
    defaultCanEdit: boolean
    defaultCanShare: boolean
    defaultManageRecords: boolean
    defaultManageUsers: boolean
}

export type DSharedFolderUser = {
    kind: 'shared_folder_user'
    sharedFolderUid: string
    username: string
    manageRecords: boolean
    manageUsers: boolean
}

export type DSharedFolderTeam = {
    kind: 'shared_folder_team'
    sharedFolderUid: string
    teamUid: string
    name: string
    manageRecords: boolean
    manageUsers: boolean
}

export type DSharedFolderRecord = {
    kind: 'shared_folder_record'
    sharedFolderUid: string
    recordUid: string
    canShare: boolean
    canEdit: boolean
}

export type DSharedFolderFolder = {
    kind: 'shared_folder_folder'
    uid: string
    data: any
    revision: number
    sharedFolderUid: string
}

export type DUserFolder = {
    kind: 'user_folder'
    uid: string
    data: any
    revision: number
}

export type DReusedPasswords = {
    kind: 'reused_passwords'
    count: number
    revision: number
}

export type DProfile = {
    kind: 'profile'
    profileName: string
    data: any
    revision: number
}

export type DContinuationToken = {
    kind?: 'continuationToken'
    token: string
}

export type Dependency = {
    kind: VaultStorageKind
    uid: string
}
export type Dependencies = Record<string, Set<Dependency>>
export type RemovedDependencies = Record<string, Set<string> | '*'>

const addDependencies = (dependencies: Dependencies, parentUid: string, childUid: string, kind: VaultStorageKind) => {
    let children = dependencies[parentUid]
    if (!children) {
        children = new Set<Dependency>()
        dependencies[parentUid] = children
    }
    children.add({
        kind: kind,
        uid: childUid
    })
}

const addRemovedDependencies = (dependencies: RemovedDependencies, parentUid: string, childUid: string) => {
    let children = dependencies[parentUid]
    if (children === '*') {
        return
    }
    if (!children) {
        children = new Set<string>()
        dependencies[parentUid] = children
    }
    children.add(childUid)
}

const getDependencies = (folderUid: string, storage: VaultStorage, results: Dependency[]) => {
    for (const dependency of storage.getDependencies(folderUid) || []) {
        switch (dependency.kind) {
            case "record":
                results.push(dependency)
                break;
            case "user_folder":
                results.push(dependency)
                getDependencies(dependency.uid, storage, results)
                break;
            default:
                throw Error('Unexpected dependency: ' + dependency.kind)
        }
    }
}

const mapKeyType = (keyType: Records.RecordKeyType): { keyId: string, encryptionType: EncryptionType } => {
    let keyId
    let encryptionType
    switch (keyType) {
        case RecordKeyType.ENCRYPTED_BY_DATA_KEY:
            keyId = 'data'
            encryptionType = 'cbc'
            break
        case RecordKeyType.ENCRYPTED_BY_DATA_KEY_GCM:
            keyId = 'data'
            encryptionType = 'gcm'
            break
        case RecordKeyType.ENCRYPTED_BY_PUBLIC_KEY:
            keyId = 'pk_rsa'
            encryptionType = 'rsa'
            break
        case RecordKeyType.ENCRYPTED_BY_PUBLIC_KEY_ECC:
            keyId = 'pk_ecc'
            encryptionType = 'ecc'
            break
        default:
            throw Error('Unknown record key type: ' + keyType)
    }
    return {keyId, encryptionType}
}

const processTeams = async (teams: ITeam[], storage: VaultStorage, dependencies: Dependencies) => {
    for (const team of teams as NN<ITeam>[]) {
        const {keyId, encryptionType} = mapKeyType(team.teamKeyType)
        const teamUid = webSafe64FromBytes(team.teamUid)
        try {
            await platform.unwrapKey(team.teamKey, teamUid, keyId, encryptionType, 'aes', storage)
            await platform.unwrapKey(team.teamPrivateKey, teamUid + '_priv', teamUid, 'cbc', 'rsa', storage)
        } catch (e: any) {
            console.error(`The team key ${teamUid} cannot be decrypted (${e.message})`)
            return
        }
        
        await storage.put({
            kind: 'team',
            uid: teamUid,
            name: team.name,
            restrictEdit: team.restrictEdit,
            restrictShare: team.restrictShare,
            restrictView: team.restrictView,
        })

        for (const folderKey of team.sharedFolderKeys as NN<ISharedFolderKey>[]) {
            const folderUid = webSafe64FromBytes(folderKey.sharedFolderUid)
            try {
                if (!folderKey.sharedFolderKey.byteLength) continue // Empty if team being removed from shared folder

                switch (folderKey.keyType) {
                    case Records.RecordKeyType.ENCRYPTED_BY_DATA_KEY:
                        await platform.unwrapKey(folderKey.sharedFolderKey, folderUid, teamUid, 'cbc', 'aes', storage)
                        break
                    case Records.RecordKeyType.ENCRYPTED_BY_PUBLIC_KEY:
                        await platform.unwrapKey(folderKey.sharedFolderKey, folderUid, teamUid + '_priv', 'rsa', 'aes', storage)
                        break
                    default:
                        console.error(`Key ${folderKey.keyType} type for team folder key ${teamUid}/${folderUid} is not supported for team folder decryption`)
                        break
                }
            } catch (e: any) {
                console.error(`The team folder key ${teamUid}/${folderUid} cannot be decrypted (${e.message})`)
            }

            addDependencies(dependencies, teamUid, folderUid, 'shared_folder')
        }
    }
}

const processFolder = async (folderUid: string, folderKey: Uint8Array, keyType: RecordKeyType, fData: Uint8Array, shared: boolean, storage: VaultStorage): Promise<any | undefined> => {
    if (keyType !== RecordKeyType.NO_KEY) {
        const {keyId, encryptionType} = mapKeyType(keyType)
        try {
            await platform.unwrapKey(folderKey, folderUid, keyId, encryptionType, 'aes', storage)
        } catch (e: any) {
            console.error(`The ${shared ? 'shared ' : ''}folder key ${folderUid} cannot be decrypted (${e.message})`)
            return
        }
    }
    try {
        const decryptedData = await platform.decrypt(fData, folderUid, 'cbc', storage)
        return JSON.parse(platform.bytesToString(decryptedData))
    } catch (e: any) {
        console.error(`The ${shared ? 'shared ' : ''}folder ${folderUid} cannot be decrypted (${e.message})`)
    }
}

const processUserFolders = async (folders: IUserFolder[], storage: VaultStorage, dependencies: Dependencies) => {
    for (const folder of folders as NN<IUserFolder>[]) {
        const folderUid = webSafe64FromBytes(folder.folderUid)
        const folderData = await processFolder(folderUid, folder.userFolderKey, folder.keyType, folder.data, false, storage)
        if (!folderData) {
            continue
        }
        await storage.put({
            kind: 'user_folder',
            uid: folderUid,
            data: folderData,
            revision: <number>folder.revision
        })
        if (folder.parentUid.length > 0) {
            addDependencies(dependencies, webSafe64FromBytes(folder.parentUid), folderUid, 'user_folder')
        }
    }
}

const processUserFolderRecords = async (folderRecords: IUserFolderRecord[], dependencies: Dependencies) => {
    for (const folderRecord of folderRecords as NN<IUserFolderRecord>[]) {
        const recUid = webSafe64FromBytes(folderRecord.recordUid)
        if (folderRecord.folderUid.length > 0) {
            addDependencies(dependencies, webSafe64FromBytes(folderRecord.folderUid), recUid, 'record')
        } else {
            // Root user folder
            addDependencies(dependencies, '', recUid, 'record')
        }
    }
}

const processSharedFolders = async (folders: ISharedFolder[], storage: VaultStorage) => {
    for (const folder of folders as NN<ISharedFolder>[]) {
        const folderUid = webSafe64FromBytes(folder.sharedFolderUid)
        const folderData = await processFolder(folderUid, folder.sharedFolderKey, folder.keyType, folder.data, true, storage)
        if (!folderData) {
            continue
        }
        await storage.put({
            kind: 'shared_folder',
            uid: folderUid,
            data: folderData,
            revision: <number>folder.revision,
            defaultCanEdit: folder.defaultCanEdit,
            defaultCanShare: folder.defaultCanReshare,
            defaultManageUsers: folder.defaultManageUsers,
            defaultManageRecords: folder.defaultManageRecords,
        })
    }
}

const processSharedFolderUsers = async (users: ISharedFolderUser[], storage: VaultStorage) => {
    for (const user of users as NN<ISharedFolderUser>[]) {
        await storage.put({
            kind: 'shared_folder_user',
            sharedFolderUid: webSafe64FromBytes(user.sharedFolderUid),
            username: user.username,
            manageRecords: user.manageRecords,
            manageUsers: user.manageUsers,
        })
    }
}

const processSharedFolderTeams = async (sharedFolderTeams: ISharedFolderTeam[], storage: VaultStorage) => {
    for (const sharedFolderTeam of sharedFolderTeams as NN<ISharedFolderTeam>[]) {
        const teamUid = webSafe64FromBytes(sharedFolderTeam.teamUid)
        const sharedFolderUid = webSafe64FromBytes(sharedFolderTeam.sharedFolderUid)

        await storage.put({
            kind: 'shared_folder_team',
            teamUid,
            sharedFolderUid,
            name: sharedFolderTeam.name,
            manageRecords: sharedFolderTeam.manageRecords,
            manageUsers: sharedFolderTeam.manageUsers,
        })
    }
}

const processSharedFolderRecords = async (records: ISharedFolderRecord[], storage: VaultStorage) => {
    for (const rec of records as NN<ISharedFolderRecord>[]) {
        const recUid = webSafe64FromBytes(rec.recordUid)
        let encryptionType
        switch (rec.recordKey.length) {
            case 60:
                encryptionType = 'gcm'
                break
            case 64:
                encryptionType = 'cbc'
                break
            default:
                throw Error('Unable to detect the shared folder key encryption type')
        }
        try {
            const sharedFolderUid = webSafe64FromBytes(rec.sharedFolderUid)
            await platform.unwrapKey(rec.recordKey, recUid, sharedFolderUid, encryptionType, 'aes', storage)
            await storage.put({
                kind: 'shared_folder_record',
                recordUid: recUid,
                sharedFolderUid,
                canEdit: rec.canEdit,
                canShare: rec.canShare,
            })
        } catch (e: any) {
            console.error(`The shared folder record ${recUid} cannot be decrypted (${e.message})`)
        }
    }
}

const processSharedFolderFolderRecords = async (records: ISharedFolderFolderRecord[], dependencies: Dependencies) => {
    for (const rec of records as NN<ISharedFolderFolderRecord>[]) {
        const parentUid = rec.folderUid.length > 0 ? webSafe64FromBytes(rec.folderUid) : webSafe64FromBytes(rec.sharedFolderUid)
        addDependencies(dependencies, parentUid, webSafe64FromBytes(rec.recordUid), 'record')
    }
}

const processUserFolderSharedFolders = async (folders: IUserFolderSharedFolder[], dependencies: Dependencies) => {
    for (const folder of folders as NN<IUserFolderSharedFolder>[]) {
        const folderUid = webSafe64FromBytes(folder.folderUid)
        const sharedFolderUid = webSafe64FromBytes(folder.sharedFolderUid)

        if (folderUid.length > 0) {
            addDependencies(dependencies, folderUid, sharedFolderUid, 'shared_folder')
        }
    }
}

const processRecordLinks = async (links: IRecordLink[], storage: VaultStorage) => {
    for (const link of links as NN<IRecordLink>[]) {
        const recUid = webSafe64FromBytes(link.childRecordUid)
        try {
            await platform.unwrapKey(link.recordKey, recUid, webSafe64FromBytes(link.parentRecordUid), 'gcm', 'aes', storage, true)
        } catch (e: any) {
            console.error(`The record link for ${recUid} cannot be decrypted (${e.message})`)
        }
    }
}

const processRecords = async (records: IRecord[], storage: VaultStorage) => {
    for (const rec of records as NN<IRecord>[]) {
        const recUid = webSafe64FromBytes(rec.recordUid)
        const encryptionType: EncryptionType = rec.version >= 3 ? 'gcm' : 'cbc'

        let extra: any
        try {
            if (rec.extra.byteLength > 0) {
                const decryptedExtra = await platform.decrypt(rec.extra, recUid, encryptionType, storage)
                extra = JSON.parse(platform.bytesToString(decryptedExtra))
            }
        } catch (e: any) {
            console.error(`The record extra data ${recUid} cannot be decrypted (${e.message})`)
        }

        try {
            const decryptedData = await platform.decrypt(rec.data, recUid, encryptionType, storage)
            const recordData = JSON.parse(platform.bytesToString(decryptedData))
            await storage.put({
                kind: 'record',
                uid: recUid,
                data: recordData,
                version: rec.version,
                revision: <number>rec.revision,
                shared: rec.shared,
                extra,
                clientModifiedTime: <number>rec.clientModifiedTime,
            })
        } catch (e: any) {
            console.error(`The record ${recUid} cannot be decrypted (${e.message})`)
        }
    }
}

const processNonSharedData = async (nonSharedData: INonSharedData[], storage: VaultStorage) => {
    for (const nsData of nonSharedData as NN<INonSharedData>[]) {
        const recUid = webSafe64FromBytes(nsData.recordUid)
        try {
            if (!nsData.data.byteLength) {
                await storage.put({
                    kind: 'non_shared_data',
                    uid: recUid,
                    data: {},
                })
                continue
            }

            const rec = storage.get('record', recUid)
            if (!rec) throw new Error('Missing record in storage')

            // While generally v3 nsData will be gcm encrypted, and v2 will be cbc encrypted, there's a case
            // where a record that has been shared to you has been converted from v2 to v3, leaving the nsData
            // still cbc encrypted. So, we fallback to cbc if gcm fails.
            const encryptionTypes: EncryptionType[] = rec.version >= 3 ? ['gcm', 'cbc'] : ['cbc']
            let decryptedNsData: Uint8Array | undefined
            const errorMessages: string[] = []
            for (const encryptionType of encryptionTypes) {
                try {
                    decryptedNsData = await platform.decrypt(nsData.data, 'data', encryptionType, storage)
                    break // exit on successful decryption
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e)
                    errorMessages.push(message)     
                }
            }
            if (!decryptedNsData) throw new Error(errorMessages.join('\n'))

            const data = JSON.parse(platform.bytesToString(decryptedNsData))
            await storage.put({
                kind: 'non_shared_data',
                uid: recUid,
                data: data,
            })
        } catch (e: any) {
            console.error(`The non shared data ${recUid} cannot be decrypted (${e.message})`)
        }
    }
}

const processReusedPasswords = async (reusedPasswords: IReusedPasswords | null | undefined, storage: VaultStorage) => {
    try {
        if (!reusedPasswords) return

        await storage.put({
          kind: 'reused_passwords',
          count: <number>reusedPasswords.count,
          revision: <number>reusedPasswords.revision
        })
    } catch (e: any) {
        console.error(`Could not process reusedPasswords (${e.message})`)
    }
}

const processProfile = async (profile: IProfile | null | undefined, storage: VaultStorage) => {
    try {
        if (!profile) return

        const prof = profile as NN<IProfile> 
        const decryptedProfileData = await platform.decrypt(prof.data, 'data', 'cbc', storage)
        const profileData = JSON.parse(platform.bytesToString(decryptedProfileData))
        await storage.put({
            kind: 'profile',
            profileName: prof.profileName,
            data: profileData,
            revision: <number>prof.revision,
        })
    } catch (e: any) {
        console.error(`Profile cannot be decrypted (${e.message})`)
    }
}

const processSharedFolderFolders = async (folders: ISharedFolderFolder[], storage: VaultStorage, dependencies: Dependencies) => {
    for (const folder of folders as NN<ISharedFolderFolder>[]) {
        const sharedFolderUid = webSafe64FromBytes(folder.sharedFolderUid)
        const folderUid = webSafe64FromBytes(folder.folderUid)
        const {encryptionType} = mapKeyType(folder.keyType)
        try {
            await platform.unwrapKey(folder.sharedFolderFolderKey, folderUid, sharedFolderUid, encryptionType, 'aes', storage)
        } catch (e: any) {
            console.error(`The shared folder folder key for ${folderUid} cannot be decrypted (${e.message})`)
        }
        try {
            const decryptedData = await platform.decrypt(folder.data, folderUid, 'cbc', storage)
            const folderData = JSON.parse(platform.bytesToString(decryptedData))
            await storage.put({
                kind: 'shared_folder_folder',
                uid: folderUid,
                data: folderData,
                revision: <number>folder.revision,
                sharedFolderUid,
            })
            if (folder.parentUid.length > 0) {
                addDependencies(dependencies, webSafe64FromBytes(folder.parentUid), folderUid, 'shared_folder_folder')
            }
        } catch (e: any) {
            console.error(`The folder folder ${folderUid} cannot be decrypted (${e.message})`)
        }
    }
}

const processRemovedUserFolderRecords = (records: IUserFolderRecord[], dependencies: RemovedDependencies) => {
    for (const record of records as Vault.UserFolderRecord[]) {
        const folderUid = webSafe64FromBytes(record.folderUid)
        const recordUid = webSafe64FromBytes(record.recordUid)
        addRemovedDependencies(dependencies, folderUid, recordUid)
    }
}

const processRemovedSharedFolderFolders = async (folders: Vault.ISharedFolderFolder[], storage: VaultStorage, dependencies: RemovedDependencies) => {
    for (const folder of folders as NN<ISharedFolderFolder>[]) {
        const sharedFolderUid = webSafe64FromBytes(folder.sharedFolderUid)
        const folderUid = webSafe64FromBytes(folder.folderUid)
        storage.delete('user_folder', folderUid)
        dependencies[folderUid] = '*'
        addRemovedDependencies(dependencies, sharedFolderUid, folderUid)
        if (folder.parentUid.length > 0) {
            addRemovedDependencies(dependencies, webSafe64FromBytes(folder.parentUid), folderUid)
        }
    }
}

const processRemovedSharedFolderTeams = async (sharedFolderTeams: ISharedFolderTeam[], dependencies: RemovedDependencies) => {
    for (const sharedFolderTeam of sharedFolderTeams as NN<ISharedFolderTeam>[]) {
        const sharedFolderUid = webSafe64FromBytes(sharedFolderTeam.sharedFolderUid)
        const teamUid = webSafe64FromBytes(sharedFolderTeam.teamUid)
        addRemovedDependencies(dependencies, sharedFolderUid, teamUid)
    }
}

const processRemovedSharedFolderUsers = (users: ISharedFolderUser[], dependencies: RemovedDependencies) => {
    for (const user of users as NN<ISharedFolderUser>[]) {
        const sharedFolderUid = webSafe64FromBytes(user.sharedFolderUid)
        addRemovedDependencies(dependencies, sharedFolderUid, user.username)
    }
}

const processRemovedSharedFolderRecords = async (records: ISharedFolderRecord[], storage: VaultStorage, dependencies: RemovedDependencies) => {
    for (const record of records as NN<ISharedFolderRecord>[]) {
        const sharedFolderUid = webSafe64FromBytes(record.sharedFolderUid)
        const recordUid = webSafe64FromBytes(record.recordUid)
        addRemovedDependencies(dependencies, sharedFolderUid, recordUid)
    }
}

const processMetadata = async (recordMetaData: IRecordMetaData[], storage: VaultStorage) => {
    for (const mData of recordMetaData as NN<IRecordMetaData>[]) {
        const {keyId, encryptionType} = mapKeyType(mData.recordKeyType)
        const recUid = webSafe64FromBytes(mData.recordUid)
        try {
            await platform.unwrapKey(mData.recordKey, recUid, keyId, encryptionType, 'aes', storage, true)
            await storage.put({
              kind: 'metadata',
              uid: recUid,
              canEdit: mData.canEdit,
              canShare: mData.canShare,
              owner: mData.owner,
            })
        } catch (e: any) {
            console.error(`The record metadata ${recUid} cannot be decrypted (${e.message})`)
        }
    }
}

export type SyncLogFormat = '!' | 'raw' | 'obj' | 'str' | 'cnt' | 'cnt_t'

const logProtobuf = (data: any, format: SyncLogFormat, seqNo: number, counts: any) => {
    switch (format) {
        case '!':
            return
        case 'raw':
            console.log(data)
            break
        case 'obj':
            console.log(JSON.parse(JSON.stringify(data)))
            break
        case 'str':
            console.log(JSON.stringify(data))
            break
        case 'cnt_t':
        case 'cnt':
            if (format === 'cnt_t') {
                console.log('continuationToken: ', platform.bytesToBase64(data.continuationToken))
            }
            console.log({
                seq: seqNo,
                ...counts
            })
            break
    }
}

const getCounts = (obj: Vault.ISyncDownResponse): SyncResponseCounts => {
    const results = {}
    for (const prop in obj) {
        if (['continuationToken', 'constructor'].includes(prop)) {
            continue
        }
        if (obj[prop]?.length) {
            results[prop] = obj[prop].length
        }
    }
    return results
}

const addCounts = (totalCounts: SyncResponseCounts, counts: SyncResponseCounts) => {
    for (const prop in counts) {
        totalCounts[prop] = (totalCounts[prop] || 0) + counts[prop]
    }
}

export interface SyncProfiler {
  time(label: string): void
  timeEnd(label: string): void 
}

export type SyncDownOptions = {
    auth: Auth,
    storage: VaultStorage
    maxCalls?: number
    logFormat?: SyncLogFormat
    profiler?: SyncProfiler
}

export const syncDown = async (options: SyncDownOptions): Promise<SyncResult> => {
    const {auth, storage, profiler} = options
    const totalCounts = {}
    let result: SyncResult = {
        started: new Date(),
        username: auth.username,
        counts: totalCounts,
        pageCount: 0,
    }
    let networkTime = 0
    try {
        const dToken = storage.get('continuationToken')
        let continuationToken = dToken ? platform.base64ToBytes(dToken.token) : undefined

        await platform.importKey('data', auth.dataKey!)
        await platform.importKeyEC('pk_ecc', new Uint8Array(auth.eccPrivateKey!), new Uint8Array(auth.eccPublicKey!))
        await platform.importKeyRSA('pk_rsa', auth.privateKey!)

        while (true) {
            const msg = syncDownMessage({
                continuationToken
            })
            let requestTime = Date.now()
            const resp = await auth.executeRest(msg)
            requestTime = Date.now() - requestTime
            const counts = getCounts(resp)
            addCounts(totalCounts, counts)
            logProtobuf(resp, options.logFormat || '!', result.pageCount, counts)
            if (resp.cacheStatus == CacheStatus.CLEAR) {
                storage.clear()
                result.fullSync = true
            }
            result.pageCount += 1
            networkTime += requestTime
            const dependencies = {}

            profiler?.time('processTeams')
            await processTeams(resp.teams, storage, dependencies)
            profiler?.timeEnd('processTeams')

            profiler?.time('processUserFolders')
            await processUserFolders(resp.userFolders, storage, dependencies)
            profiler?.timeEnd('processUserFolders')

            profiler?.time('processUserFolderRecords')
            await processUserFolderRecords(resp.userFolderRecords, dependencies)
            profiler?.timeEnd('processUserFolderRecords')

            profiler?.time('processSharedFolders')
            await processSharedFolders(resp.sharedFolders, storage)
            profiler?.timeEnd('processSharedFolders')

            profiler?.time('processSharedFolderUsers')
            await processSharedFolderUsers(resp.sharedFolderUsers, storage)
            profiler?.timeEnd('processSharedFolderUsers')

            profiler?.time('processSharedFolderTeams')
            await processSharedFolderTeams(resp.sharedFolderTeams, storage)
            profiler?.timeEnd('processSharedFolderTeams')

            profiler?.time('processSharedFolderRecords')
            await processSharedFolderRecords(resp.sharedFolderRecords, storage)
            profiler?.timeEnd('processSharedFolderRecords')

            profiler?.time('processSharedFolderFolderRecords')
            await processSharedFolderFolderRecords(resp.sharedFolderFolderRecords, dependencies)
            profiler?.timeEnd('processSharedFolderFolderRecords')

            profiler?.time('processUserFolderSharedFolders')
            await processUserFolderSharedFolders(resp.userFolderSharedFolders, dependencies)
            profiler?.timeEnd('processUserFolderSharedFolders')

            profiler?.time('processMetadata')
            await processMetadata(resp.recordMetaData, storage)
            profiler?.timeEnd('processMetadata')

            profiler?.time('processRecordLinks')
            await processRecordLinks(resp.recordLinks, storage)
            profiler?.timeEnd('processRecordLinks')

            profiler?.time('processRecords')
            await processRecords(resp.records, storage)
            profiler?.timeEnd('processRecords')

            profiler?.time('processNonSharedData')
            await processNonSharedData(resp.nonSharedData, storage)
            profiler?.timeEnd('processNonSharedData')

            profiler?.time('processSharedFolderFolders')
            await processSharedFolderFolders(resp.sharedFolderFolders, storage, dependencies)
            profiler?.timeEnd('processSharedFolderFolders')

            profiler?.time('processReusedPasswords')
            await processReusedPasswords(resp.reusedPasswords, storage)
            profiler?.timeEnd('processReusedPasswords')

            profiler?.time('processProfile')
            await processProfile(resp.profile, storage)
            profiler?.timeEnd('processProfile')

            storage.addDependencies(dependencies)

            const removedDependencies = {}
            for (let teamUid of resp.removedTeams) {
                storage.delete('team', webSafe64FromBytes(teamUid))
            }
            for (const recUid of resp.removedRecords) {
                storage.delete('record', webSafe64FromBytes(recUid))
            }
            for (const recordLink of resp.removedRecordLinks as Vault.RecordLink[]) {
                const parentUid = webSafe64FromBytes(recordLink.parentRecordUid)
                const childUid = webSafe64FromBytes(recordLink.childRecordUid)
                addRemovedDependencies(removedDependencies, parentUid, childUid)
            }
            for (const folder of resp.removedUserFolders) {
                const folderUid = webSafe64FromBytes(folder)
                removedDependencies[folderUid] = '*'
                storage.delete('user_folder', folderUid)
            }
            processRemovedUserFolderRecords(resp.removedUserFolderRecords, removedDependencies)
            await processRemovedSharedFolderFolders(resp.removedSharedFolderFolders, storage, removedDependencies)
            await processRemovedSharedFolderTeams(resp.removedSharedFolderTeams, removedDependencies)
            processRemovedSharedFolderUsers(resp.removedSharedFolderUsers, removedDependencies)
            await processRemovedSharedFolderRecords(resp.removedSharedFolderRecords, storage, removedDependencies)

            const removedSFDependencies: Dependency[] = []
            for (const folder of resp.removedSharedFolders) {
                const folderUid = webSafe64FromBytes(folder)
                getDependencies(folderUid, storage, removedSFDependencies)
                removedDependencies[folderUid] = '*'
                storage.delete('shared_folder', folderUid)
            }
            for (const removedSFDependency of removedSFDependencies) {
                switch (removedSFDependency.kind) {
                    case "record":
                        storage.delete('record', removedSFDependency.uid)
                        break;
                    case "user_folder":
                        removedDependencies[removedSFDependency.uid] = '*'
                        storage.delete('user_folder', removedSFDependency.uid)
                        break;
                }
            }
            storage.removeDependencies(removedDependencies)

            continuationToken = resp.continuationToken || undefined
            result.continuationToken = platform.bytesToBase64(continuationToken)
            await storage.put({
                kind: 'continuationToken',
                token: platform.bytesToBase64(resp.continuationToken)
            })
            if (!resp.hasMore || (options.maxCalls && result.pageCount >= options.maxCalls)) {
                break
            }
        }
    } catch (e: any) {
        console.error(e)
        result.error = e.message
    }
    result.networkTime = formatTimeDiff(new Date(networkTime))
    result.totalTime = formatTimeDiff(new Date(Date.now() - result.started.getTime()))
    return result
}
