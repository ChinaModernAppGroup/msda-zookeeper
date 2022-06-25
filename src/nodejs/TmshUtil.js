/**
 * Copyright 2021 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const pathResolve = require('path').resolve;

const metadataTag = 'appsvcs-discovery';

// primitive locking mechanism
let tmshLock = 0;
function generateListCommand(path) {
    return `tmsh -a list ${path}`;
}

function generatePoolMemberCommand(poolName, input) {
    function generateMemberOptions(member) {
        return Object.keys(member)
            .filter(key => key !== 'name')
            .map((key) => {
                const value = member[key];
                const prop = key.replace(/[A-Z]/g, c => `-${c.toLowerCase(c)}`);
                return `${prop} ${value}`;
            }).join(' ');
    }
    const tmshMembers = input
        .map(member => `${member.name} { ${generateMemberOptions(member)} }`)
        .join(' ');
    const memberString = (tmshMembers) ? `replace-all-with { ${tmshMembers} }` : 'none';
    const command = `tmsh -a modify ltm pool ${poolName} members ${memberString}`;
    return command;
}

function generateAddNodeCommand(node) {
    // eslint-disable-next-line max-len
    return `tmsh -a create ltm node ${node.id} address ${node.ip} metadata replace-all-with { ${metadataTag} { } }`;
}

function generateBulkDeleteNodeCommand(nodes) {
    // eslint-disable-next-line max-len
    //
    if (nodes.length === 0) return null;
    let cmd = `cli script __service-discovery {
proc script::run {} {
  if { [catch {
    tmsh::begin_transaction\n    `;
    cmd += nodes.map(node => `tmsh::delete ltm node ${node.id}`).join('\n    ');
    cmd += `\n    tmsh::commit_transaction
  } err] } {\n    `;
    cmd += nodes.map(node => `catch { tmsh::delete ltm node ${node.id} }`).join('\n');
    cmd += `
}
}
}`;
    return cmd;
}

function generateBulkAddNodeCommand(nodes) {
    // eslint-disable-next-line max-len
    //
    if (nodes.length === 0) return null;
    let cmd = `cli script __service-discovery {
proc script::run {} {
  tmsh::begin_transaction\n`;
    cmd += nodes.map(node => `tmsh::create ltm node ${node.id} address ${node.ip} metadata replace-all-with \\{ ${metadataTag} \\{ \\} \\}`).join('\n');
    cmd += `\ntmsh::commit_transaction
}
}`;
    return cmd;
}

function generateDeleteNodeCommand(path) {
    return `tmsh -a delete ltm node ${path}`;
}

function generateAddFolderCommand(path) {
    return `tmsh -a create sys folder ${path}`;
}

function generateAddDataGroupCommand(path) {
    return `tmsh -a create ltm data-group internal ${path} type string`;
}

function generateUpdateDataGroupCommand(path, records) {
    const tmshRecords = records
        .map(record => `${record.name} { data ${record.data} }`)
        .join(' ');
    // eslint-disable-next-line max-len
    const command = `tmsh -a modify ltm data-group internal ${path} records replace-all-with { ${tmshRecords} }`;
    return command;
}

function generateReadDataGroupCommand(path) {
    return `tmsh -a list ltm data-group internal ${path}`;
}

function generateUpdateAddressListCommand(path, addresses) {
    let addrString = 'none';
    if (addresses.length > 0) {
        addrString = `replace-all-with { ${addresses.join(' ')} }`;
    }
    return `tmsh -a modify security firewall address-list ${path} addresses ${addrString}`;
}

function generateUpdateAddressListSafeCommand(path, addresses) {
    // eslint-disable-next-line max-len
    return `tmsh -a modify security firewall address-list ${path} addresses replace-all-with { ${addresses.join(' ') || '::1:5ee:bad:c0de'} }`;
}

function executeCommand(command) {
    const lockIt = new Promise((resolve) => {
        tmshLock += 1;
        if (tmshLock > 1) {
            tmshLock -= 1;
            setTimeout(resolve, Math.round(Math.random() * (1000 * tmshLock)) + 100, executeCommand, command);
        } else {
            resolve();
        }
    });
    return lockIt.then(() => new Promise((resolve, reject) => {
        const commandArgs = command.split(' ');
        const commandName = commandArgs.shift();
        let result = '';
        const cp = childProcess.spawn(commandName, commandArgs, { shell: '/bin/bash' });

        cp.stdout.on('data', (data) => {
            result += data;
        });

        cp.stderr.on('data', (data) => {
            reject(new Error(data));
        });

        cp.on('close', (code) => {
            tmshLock -= 1;

            if (code !== 0) {
                reject(new Error(result));
            }

            resolve(result);
        });
    }));
}

function createCliScript() {
    const command = `cli script __service-discovery {
        proc script::run {} {
            set names {}
            set addresses {}
            set shouldGet ''
            set action [lindex $tmsh::argv 1]
            foreach i $tmsh::argv {
            if { $i eq "--names" } {
                set shouldGet "names"
                continue
            }
            if { $i eq "--addresses" } {
                set shouldGet "addresses"
                continue
            }
            if { $shouldGet eq "names" } {
                if { $action eq "delete" } {
                    set node [tmsh::get_config /ltm node $i]
                    if {[catch {
                        set metadata "[tmsh::get_field_value [lindex $node 0] "metadata"]"
                        if { [lindex [lindex $metadata 0 ] 1]  ne "${metadataTag}" } {
                            continue
                        }
                        } err]} {  }
                }
                lappend names $i
            }
            if { $shouldGet eq "addresses" } {
                lappend addresses $i
            }
            }
            set i 0
            tmsh::stateless enabled
            tmsh::begin_transaction
            foreach name $names {
            if { $action eq "create" } {
                set address [lindex $addresses $i]
                tmsh::create ltm node $name address $address metadata replace-all-with \\{ ${metadataTag} \\{ \\} \\}
            } elseif { $action eq "delete" } {
                tmsh::delete ltm node $name
            } elseif { $action eq "addMetadata" } {
                tmsh::modify ltm node $name metadata add \\{ ${metadataTag} \\{ \\} \\}
            } elseif { $action eq "removeMetadata" } {
                tmsh::modify ltm node $name metadata delete \\{ ${metadataTag} \\{ \\} \\}
            }
            incr i
            }
            tmsh::commit_transaction
        }
    }`;

    if (command === null) return Promise.resolve(null);
    const writeFile = new Promise((resolve, reject) => {
        fs.open('/var/tmp/service-discovery.cli', 'wx', (openErr, fd) => {
            if (openErr) {
                // existing file or other error, try and delete, then try again, or fail out
                fs.unlink('/var/tmp/service-discovery.cli', (err) => { if (err) reject(new Error('unable to create /var/tmp/service-discovery.cli, please delete this file to use service-discovery')); else resolve(createCliScript()); });
            } else {
                fs.write(fd, command, (writeErr) => {
                    if (writeErr) reject(writeErr);
                    fs.close(fd, () => resolve());
                });
            }
        });
    });
    return writeFile.then(() => executeCommand('tmsh -a -c \'load sys config merge file /var/tmp/service-discovery.cli; run util unix-rm /var/tmp/service-discovery.cli\''));
}

function generateNodeCliScript(action, nodes) {
    const input = { names: [], addresses: [] };
    nodes.forEach((node) => { input.names.push(node.id); input.addresses.push(node.ip); });
    let cmd = `tmsh -a run cli script __service-discovery ${action}`;
    cmd += ` --names ${input.names.join(' ')}`;
    if (action === 'create') cmd += ` --addresses ${input.addresses.join(' ')}`;
    return cmd;
}

function list(path) {
    return executeCommand(generateListCommand(path));
}

function updatePoolMembers(poolName, members) {
    return executeCommand(generatePoolMemberCommand(poolName, members));
}

function addNode(node) {
    return executeCommand(generateAddNodeCommand(node));
}

function getAllNodes() {
    const listAll = executeCommand('tmsh -a -c \'cd /; list /ltm node recursive one-line\'');
    return listAll
        .then(output => output.trim().split('\n'));
}

/**
 * Filters out existing nodes and separates remaining nodes into
 * nodes that need to be created and nodes that that just need metadata
 *
 * @param {String[]} existingNodes - Array of strings. One for each node as returned by 'tmsh list ltm node'
 * @param {Object[]} nodesToAdd - list of nodes to add
 *
 * @returns {Object} Object that contains a list of nodes that need
 *                   to be created and nodes that that just need metadata added
 */
function filterNodesToAdd(existingNodes, nodesToAdd) {
    // extract name, IP address, and metadata of existing node
    const nodeHash = createNodeHash(existingNodes);

    // add all nodes who's ip doesn't already exist
    const createNodes = nodesToAdd.filter(n => !(n.ip in nodeHash));

    // for nodes who's ip already exists, add the SD metadata tag if it's not there
    const creatingIps = createNodes.map(n => n.ip);
    const addMetadata = nodesToAdd
        .filter(n => creatingIps.indexOf(n.ip) === -1)
        .filter(n => (n.ip in nodeHash && nodeHash[n.ip].metadata.indexOf(metadataTag) === -1))
        .map(n => Object.assign(n, { id: pathResolve('/', nodeHash[n.ip].id) }));

    return { createNodes, addMetadata };
}

/**
 * Filters out existing nodes and separates remaining nodes into
 * nodes that need to be deleted and nodes that that just need metadata removed
 *
 * @param {String[]} existingNodes - Array of strings. One for each node as returned by 'tmsh list ltm node'
 * @param {Object[]} nodesToDelete - list of nodes to delete
 *
 * @returns {Object} Object that contains a list of nodes that need
 *                   to be created and nodes that that just need metadata
 */
function filterNodesToDelete(existingNodes, nodesToDelete) {
    // extract name, IP address, and metadata of existing node
    const nodeHash = createNodeHash(existingNodes);

    // delete all nodes who's name (id) matches an existing node
    const existingIds = Object.keys(nodeHash).map(ip => pathResolve('/', nodeHash[ip].id));
    const deleteNodes = nodesToDelete.filter(n => existingIds.indexOf(n.id) !== -1);
    const deletingIps = deleteNodes.map(n => n.ip);

    // for other nodes, if we have the IP but the name does not match, just remove the metadata
    const removeMetadata = nodesToDelete
        .filter(n => deletingIps.indexOf(n.ip) === -1)
        .filter(n => (n.ip in nodeHash && nodeHash[n.ip].metadata.indexOf(metadataTag) !== -1))
        .map(n => Object.assign(n, { id: pathResolve('/', nodeHash[n.ip].id) }));

    return { deleteNodes, removeMetadata };
}

/**
 * Creates a hash of node IP address to info about the node
 *
 * @param {String[]} existingNodes - Array of strings. One for each node as returned by 'tmsh list ltm node'
 * @returns {Object} Map of node IP address to info about node. Info contains id and metadata
 */
function createNodeHash(existingNodes) {
    const nodeHash = {};
    existingNodes.forEach((nodeStr) => {
        const m = /node (\S+).*address (\S+)/.exec(nodeStr);
        const subStr = (nodeStr.split('metadata {')[1] || '');
        let braceCount = 1;
        let metadata = '';

        for (let i = 0; i < subStr.length; i += 1) {
            if (subStr[i] === '{') {
                braceCount += 1;
            } else if (subStr[i] === '}') {
                braceCount -= 1;
            }

            if (braceCount === 0) {
                break;
            }

            metadata += subStr[i];
        }

        if (m) {
            const existingNodeArray = m.slice(1, 3).reverse();
            nodeHash[existingNodeArray[0]] = {
                id: existingNodeArray[1],
                metadata
            };
        }
    });
    return nodeHash;
}

function addBulkNodes(nodesToAdd) {
    if (nodesToAdd.length === 0) return Promise.resolve(null);
    return getAllNodes()
        .then(allNodes => filterNodesToAdd(allNodes, nodesToAdd))
        .then((filteredNodes) => {
            if (filteredNodes.createNodes.length > 0) {
                return executeCommand(generateNodeCliScript('create', filteredNodes.createNodes))
                    .then(() => filteredNodes);
            }
            return Promise.resolve(filteredNodes);
        })
        .then((filteredNodes) => {
            if (filteredNodes.addMetadata.length > 0) {
                return executeCommand(generateNodeCliScript('addMetadata', filteredNodes.addMetadata));
            }
            return Promise.resolve();
        });
}

function deleteBulkNodes(nodesToDelete) {
    let error;
    if (nodesToDelete.length === 0) return Promise.resolve(null);
    return getAllNodes()
        .then(allNodes => filterNodesToDelete(allNodes, nodesToDelete))
        .then((filteredNodes) => {
            if (filteredNodes.deleteNodes.length > 0) {
                return executeCommand(generateNodeCliScript('delete', filteredNodes.deleteNodes))
                    .catch((err) => { error = error || err; })
                    .then(() => filteredNodes);
            }
            return Promise.resolve(filteredNodes);
        })
        .then((filteredNodes) => {
            if (filteredNodes.removeMetadata.length > 0) {
                return executeCommand(generateNodeCliScript('removeMetadata', filteredNodes.removeMetadata))
                    .catch((err) => { error = error || err; });
            }
            return Promise.resolve();
        })
        .then(() => {
            if (error) {
                return Promise.reject(error);
            }
            return Promise.resolve();
        });
}

function deleteNode(node) {
    return executeCommand(generateDeleteNodeCommand(node));
}

function addFolder(path) {
    return executeCommand(generateAddFolderCommand(path));
}

function addDataGroup(path) {
    return executeCommand(generateAddDataGroupCommand(path));
}

function updateDataGroup(path, records) {
    return executeCommand(generateUpdateDataGroupCommand(path, records));
}

function readDataGroup(path) {
    return executeCommand(generateReadDataGroupCommand(path));
}

function updateAddressList(path, addresses) {
    return executeCommand(generateUpdateAddressListCommand(path, addresses));
}

function updateAddressListSafe(path, addresses) {
    return executeCommand(generateUpdateAddressListSafeCommand(path, addresses));
}

function findObjectEndLine(lines, start) {
    function stringCount(string, pattern) {
        return (string.match(pattern) || []).length;
    }

    let level = 0;
    let endLine = null;
    lines.forEach((line, i) => {
        if (i < start) return;
        if (endLine !== null) return;
        level += stringCount(line, /{/g);
        level -= stringCount(line, /}/g);
        if (level <= 0) endLine = i + start;
    });
    return endLine;
}

function outputToObject(output, start, end) {
    const result = {};
    const startLine = (start || 0) + 1;
    const endLine = end || -1;

    const lines = output.split('\n').slice(startLine, endLine);

    let skipTo = -1;
    lines.forEach((line, i) => {
        if (i < skipTo) return;
        const tokens = line.trim().split(/\s+/);
        const key = tokens.slice(0, -1).join(' ');
        let value = tokens.pop();
        if (value === '{') {
            skipTo = findObjectEndLine(lines, i) + 1;
            value = outputToObject(output, i + startLine, skipTo + startLine);
        }
        if (key) {
            result[key] = value;
        }
    });
    return result;
}

function generateReadNodesCommand() {
    return 'tmsh -a -c \'cd /; list ltm node recursive\'';
}

function getNodeByIp(ip) {
    return executeCommand(generateReadNodesCommand())
        .then((result) => {
            const lines = result.split('\n');
            let id = null;
            lines.forEach((line, i) => {
                if (line.indexOf(ip) > -1 && line.indexOf('address') > -1) {
                    const nameLine = lines[i - 1];
                    id = nameLine.replace(/ltm node ([^ ]*) {/, '$1');
                }
            });

            if (id === null) {
                throw Error(`Node with IP ${ip} was not found`);
            }

            return {
                id,
                ip
            };
        });
}

function checkNodesExist(nodes) {
    if (!nodes || !nodes.length) {
        return Promise.reject(new Error('The var "nodes" must be instantiated and be an array for comparison'));
    }

    return executeCommand(generateReadNodesCommand())
        .then((result) => {
            // This does a copy of the id into another array
            let nodesNotFound = nodes.map(node => ({
                id: (node.id.charAt(0) === '/') ? node.id.substr(1) : node.id
            }));

            result.split('\n').forEach((line) => {
                if (line.includes('ltm node')) {
                    // Remove any nodes that are match id for node on BIG-IP
                    nodesNotFound = nodesNotFound.filter(node => !line.includes(node.id));
                }
            });

            if (nodesNotFound.length === 0) {
                return Promise.resolve();
            }

            return Promise.reject(new Error(
                `The following nodes are not on the BIG-IP: ${JSON.stringify(nodesNotFound)}`
            ));
        });
}

function itemExists(path) {
    return list(path)
        .then(() => true)
        .catch((err) => {
            if (err.message.indexOf('was not found') >= 0) {
                return false;
            }
            throw err;
        });
}

function folderExists(path) {
    return itemExists(`sys folder ${path}`);
}

function dataGroupExists(path) {
    return itemExists(`ltm data-group internal ${path}`);
}

module.exports = {
    generateListCommand,
    generatePoolMemberCommand,
    generateAddNodeCommand,
    generateBulkAddNodeCommand,
    generateDeleteNodeCommand,
    generateBulkDeleteNodeCommand,
    generateAddFolderCommand,
    generateAddDataGroupCommand,
    generateUpdateDataGroupCommand,
    generateReadDataGroupCommand,
    generateUpdateAddressListCommand,
    generateUpdateAddressListSafeCommand,
    executeCommand,
    createCliScript,
    createNodeHash,
    itemExists,
    list,
    updatePoolMembers,
    addNode,
    addBulkNodes,
    deleteBulkNodes,
    deleteNode,
    addFolder,
    addDataGroup,
    updateDataGroup,
    readDataGroup,
    updateAddressList,
    updateAddressListSafe,
    outputToObject,
    getNodeByIp,
    checkNodesExist,
    getAllNodes,
    filterNodesToAdd,
    filterNodesToDelete,
    folderExists,
    dataGroupExists
};
