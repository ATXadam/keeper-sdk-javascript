import {Auth} from "./auth";
// import {
//     EnterpriseAllocateIdsCommand,
//     EnterpriseDataInclude,
//     GetEnterpriseDataCommand,
//     GetEnterpriseDataResponse,
//     NodeAddCommand,
//     RoleAddCommand,
//     TeamAddCommand,
//     EnterpriseUserAddCommand
// } from "./commands";
import {
    decryptFromStorage,
    decryptObjectFromStorage,
    encryptForStorage,
    encryptObjectForStorage,
    encryptKey,
    decryptKey,
    generateUid,
    generateEncryptionKey,
    webSafe64FromBytes, normal64Bytes
} from "./utils";
import {platform} from "./platform";

// export class Company {
//
//     private _data: GetEnterpriseDataResponse;
//     private treeKey: Uint8Array;
//
//     constructor(private auth: Auth) {
//     }
//
//     async load(include: EnterpriseDataInclude[]) {
//         let getEnterpriseDataCommand = new GetEnterpriseDataCommand();
//         getEnterpriseDataCommand.include = include;
//
//         this._data = await this.auth.executeCommand(getEnterpriseDataCommand);
//
//         if (this._data.msp_key) {
//             let key4TreeKey
//             switch (this._data.msp_key.encrypted_msp_tree_key_type) {
//                 case 'encrypted_by_data_key':
//                     key4TreeKey = decryptFromStorage(this._data.msp_key.encrypted_msp_tree_key, this.auth.dataKey);
//                     break;
//                 case 'encrypted_by_public_key':
//                     key4TreeKey = platform.privateDecrypt(normal64Bytes(this._data.msp_key.encrypted_msp_tree_key), this.auth.privateKey)
//                     break;
//                 case 'no_key':
//                     throw new Error('invalid value for encrypted_msp_tree_key_type')
//             }
//             this.treeKey = await decryptKey(this._data.tree_key, key4TreeKey);
//         } else {
//             if (this._data.key_type_id === 1) {
//                 this.treeKey = await decryptFromStorage(this._data.tree_key, this.auth.dataKey);
//             }
//             else {
//                 this.treeKey = platform.privateDecrypt(normal64Bytes(this._data.tree_key), this.auth.privateKey)
//             }
//         }
//
//         if (!this._data.roles)
//             this._data.roles = [];
//         if (!this._data.teams)
//             this._data.teams = [];
//         if (!this._data.users)
//             this._data.users = [];
//
//         for (let node of this._data.nodes) {
//             node.displayName = (await decryptObjectFromStorage<EncryptedData>(node.encrypted_data, this.treeKey)).displayname;
//             if (node.parent_id) {
//                 let parent = this._data.nodes.find(x => x.node_id == node.parent_id);
//                 if (!parent) {
//                     throw new Error(`Unable to find parent for node:${node.parent_id}`)
//                 }
//
//                 if (!parent.nodes) {
//                     parent.nodes = []
//                 }
//                 parent.nodes.push(node);
//             }
//         }
//
//         for (let role of this._data.roles) {
//
//             if (role.role_type === "pool_manager") {
//                 role.displayName = "License Purchaser"
//             }
//             else {
//                 switch (role.key_type) {
//                     case "encrypted_by_data_key":
//                         role.displayName = (await decryptObjectFromStorage<EncryptedData>(role.encrypted_data, this.treeKey)).displayname;
//                         break;
//                     case "encrypted_by_public_key":
//                         throw "Not Implemented";
//                     case "no_key":
//                         role.displayName = role.encrypted_data;
//                         break;
//                 }
//             }
//
//             let node = this._data.nodes.find(x => x.node_id == role.node_id);
//             if (!node) {
//                 throw new Error(`Unable to find node for role:${role.node_id}`)
//             }
//
//             if (!node.roles) {
//                 node.roles = []
//             }
//             node.roles.push(role);
//         }
//
//         for (let team of this._data.teams) {
//             let node = this._data.nodes.find(x => x.node_id == team.node_id);
//             if (!node) {
//                 throw new Error(`Unable to find node for team:${team.node_id}`)
//             }
//
//             if (!node.teams) {
//                 node.teams = []
//             }
//             node.teams.push(team);
//         }
//
//         for (let user of this._data.users) {
//             switch (user.key_type) {
//                 case "encrypted_by_data_key":
//                     user.displayName = (await decryptObjectFromStorage<EncryptedData>(user.encrypted_data, this.treeKey)).displayname;
//                     break;
//                 case "encrypted_by_public_key":
//                     throw "Not Implemented";
//                 case "no_key":
//                     user.displayName = user.encrypted_data;
//                     break;
//             }
//
//             let node = this._data.nodes.find(x => x.node_id == user.node_id);
//             if (!node) {
//                 throw new Error(`Unable to find node for user:${user.node_id}`)
//             }
//
//             if (!node.users) {
//                 node.users = []
//             }
//             for (let user_role of this._data.role_users || []) {
//                 if (user_role.enterprise_user_id == user.enterprise_user_id) {
//                     if (!user.roles) {
//                         user.roles = []
//                     }
//
//                     const role = this._data.roles.find(x => x.role_id === user_role.role_id)
//                     if (!role) {
//                         throw new Error(`Unable to find role for user_role:${user_role.role_id}`)
//                     }
//
//                     user.roles.push(role)
//                 }
//             }
//             for (let user_team of this._data.team_users || []) {
//                 if (user_team.enterprise_user_id == user.enterprise_user_id) {
//                     if (!user.teams) {
//                         user.teams = []
//                     }
//
//                     const team = this._data.teams.find(x => x.team_uid === user_team.team_uid)
//                     if (!team) {
//                         throw new Error(`Unable to find team for user_team:${user_team.team_uid}`)
//                     }
//
//                     user.teams.push(team)
//                 }
//             }
//             node.users.push(user);
//         }
//     }
//
//     get data(): GetEnterpriseDataResponse {
//         return this._data;
//     }
//
//     encryptDisplayName(displayName: string): Promise<string> {
//         return encryptObjectForStorage<EncryptedData>({
//             displayname: displayName
//         }, this.treeKey);
//     }
//
//     encryptForStorage(data: Uint8Array): Promise<string> {
//         return encryptForStorage(data, this.treeKey);
//     }
//
//     async encryptKey(key: Uint8Array): Promise<string> {
//         return encryptKey(key, this.treeKey);
//     }
//
//     async encryptKeyAsBytes(key: Uint8Array): Promise<Uint8Array> {
//         return platform.aesGcmEncrypt(key, this.treeKey)
//     }
//
//     async decryptKey(encryptedKey: string): Promise<Uint8Array> {
//         return decryptKey(encryptedKey, this.treeKey);
//     }
//
//     async allocateIDs(count: number): Promise<number> {
//         let allocateCommand = new EnterpriseAllocateIdsCommand();
//         allocateCommand.number_requested = count;
//         let response = await this.auth.executeCommand(allocateCommand);
//         return response.base_id;
//     }
//
//     async addNode(parentNodeId: number, nodeName: string): Promise<number> {
//         let nodeId = await this.allocateIDs(1);
//         let nodeAddCommand = new NodeAddCommand(nodeId, parentNodeId, await this.encryptDisplayName(nodeName));
//         let response = await this.auth.executeCommand(nodeAddCommand);
//         return nodeId;
//     }
//
//     async addRole(nodeId: number, roleName: string): Promise<number> {
//         let roleId = await this.allocateIDs(1);
//         let roleAddCommand = new RoleAddCommand(roleId, nodeId, await this.encryptDisplayName(roleName));
//         let response = await this.auth.executeCommand(roleAddCommand);
//         return roleId;
//     }
//
//     async addTeam(nodeId: number, teamName: string) {
//         let teamUid = generateUid();
//         let teamKeyBytes = generateEncryptionKey();
//         let {privateKey, publicKey} = await platform.generateRSAKeyPair();
//         let publicKey64 = webSafe64FromBytes(publicKey);
//         let encryptedPrivateKey = encryptForStorage(privateKey, teamKeyBytes);
//         let teamKey = await encryptForStorage(teamKeyBytes, this.auth.dataKey);
//         let encryptedTeamKey = await this.encryptKey(teamKeyBytes);
//         let teamAddCommand = new TeamAddCommand(teamUid, teamName, nodeId, publicKey64, await encryptedPrivateKey, teamKey, encryptedTeamKey);
//         let response = await this.auth.executeCommand(teamAddCommand);
//     }
//
//     async addUser(nodeId: number, email: string, userName: string): Promise<{userId: number; verification_code: string}> {
//         let userId = await this.allocateIDs(1);
//         let userAddCommand = new EnterpriseUserAddCommand(userId, email, nodeId, await this.encryptDisplayName(userName));
//         let response = await this.auth.executeCommand(userAddCommand);
//         let verification_code = response.verification_code;
//         return {userId, verification_code};
//     }
// }

export type EncryptedData = {displayname: string}
