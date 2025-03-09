/*
  Copyright (c) 2017, F5 Networks, Inc.
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
  *
  http://www.apache.org/licenses/LICENSE-2.0
  *
  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
  either express or implied. See the License for the specific
  language governing permissions and limitations under the License.
  
  Updated by Ping Xiong on May/15/2022.
  Updated by Ping Xiong on Jun/30/2022, using global var for polling signal.
  Updated by Ping Xiong on Oct/04/2022, modify the polling signal into a json object to keep more information.
  let blockInstance = {
    name: "instanceName", // a block instance of the iapplx config
    state: "polling", // can be "polling" for normal running state; "update" to modify the iapplx config
    bigipPoolChange: false, // Add a signal for bigip pool change update
    bigipPool: "/Common/samplePool"
  }
  Updated by Ping Xiong on Jan/07/2023, add applicationType dropdown list, parse host(ip:port) from DCITS dubbo url
  Mar/09/2023, update delta of pool members instead of replace-all-with latest config. Updated by Ping Xiong.
  Aug/11/2023, updated by Ping Xiong, update config will not delete the pool unless the pool changed.
  Mar/09/2025, updated by Ping Xiong,add initial polling before the main loop and also enable watching the service registry.
*/

'use strict';

// Middleware. May not be installed.
var configTaskUtil = require("./configTaskUtil");
var blockUtil = require("./blockUtils");
var logger = require('f5-logger').getInstance();
var mytmsh = require('./TmshUtil');
var zookeeper = require('node-zookeeper-client');
//var EventEmitter = require('events').EventEmitter;
//var stopPollingEvent = new EventEmitter();
var url = require("url");
var urlencode = require("urlencode");


// Setup a polling signal for audit.
//var fs = require('fs');
//const msdazkOnPollingSignal = '/var/tmp/msdazkOnPolling';
global.msdazkOnPolling = [];


//const pollInterval = 10000; // Interval for polling Registry registry.
//var stopPolling = false;

// For functionnal verification
//const poolName = 'pool_msda_demo';
//const poolType = 'round-robin';
//const healthMonitor = 'tcp';
var poolMembers = '{100.100.100.100:8080 100.100.100.101:8080}';
//const commandCreatePool ='tmsh -a create ltm pool pool_msda_demo monitor tcp load-balancing-mode round-robin members replace-all-with { 100.100.100.100:8080 100.100.100.101:8080 }';
//const commandUpdatePool ='tmsh -a modify ltm pool pool_msda_demo monitor tcp load-balancing-mode round-robin members replace-all-with { 100.100.100.100:8080 100.100.100.101:8080 }';
//const commandDeletePool ='tmsh -a delete ltm pool pool_msda_demo';

// tmsh -a create ltm pool /Common/pool_msda_demo
// tmsh -a modify ltm pool /Common/pool_msda_demo monitor tcp load-balancing-mode round-robin members replace-all-with { 100.100.100.100:8080 100.100.100.101:8080 }

/**
 * A dynamic config processor for managing LTM pools.
 * Note that the pool member name is not visible in the GUI. It is generated by MCP according to a pattern, we don't want
 * the user setting it
 *
 * @constructor
 */
function msdazkConfigProcessor() {
}

msdazkConfigProcessor.prototype.setModuleDependencies = function (options) {
    logger.info("setModuleDependencies called");
    configTaskUtil = options.configTaskUtil;
};

msdazkConfigProcessor.prototype.WORKER_URI_PATH = "shared/iapp/processors/msdazkConfig";

msdazkConfigProcessor.prototype.onStart = function (success) {
    logger.fine("MSDA: OnStart, msdazkConfigProcessor.prototype.onStart");
    this.apiStatus = this.API_STATUS.INTERNAL_ONLY;
    this.isPublic = true;

    configTaskUtil.initialize({
        restOperationFactory: this.restOperationFactory,
        eventChannel: this.eventChannel,
        restHelper: this.restHelper
    });
    
    // Check the db key bigpipe.displayservicenames, modify it into false if needed.
    mytmsh.executeCommand("tmsh -a list sys db bigpipe.displayservicenames")
    .then(function (result) {
        if (result.indexOf("true") > -1) {
            logger.fine(
                "MSDA: onStart, bigpipe.displayservicenames is true, will modify it into false."
            );
            return mytmsh
                .executeCommand(
                "tmsh -a modify sys db bigpipe.displayservicenames value false"
                )
                .then(function () {
                logger.fine(
                    "MSDA: onStart, updated bigpipe.displayservicenames into false."
                );
                });
        } else {
            return logger.fine(
              "MSDA: onStart, bigpipe.displayservicenames is false, no change needed."
            );
        }
    }, function () {
        return logger.fine(
            "MSDA: onStart, fail to list the db key bigpipe.displayservicenames."
        );
    })
    .catch(function (error) {
        logger.fine(
          "MSDA: onStart, fail to list the db key bigpipe.displayservicenames. ",
          error.message
        );
    });

    success();
};


/**
 * Handles initial configuration or changed configuration. Sets the block to 'BOUND' on success
 * or 'ERROR' on failure. The routine is resilient in that it will try its best and always go
 * for the 'replace' all attitude.
 *
 * @param restOperation - originating rest operation that triggered this processor
 */
msdazkConfigProcessor.prototype.onPost = function (restOperation) {
    var configTaskState,
        blockState,
        oThis = this;
    logger.fine("MSDA: onPost, msdazkConfigProcessor.prototype.onPost");

    var instanceName;
    var inputProperties;
    var dataProperties;
    try {
        configTaskState = configTaskUtil.getAndValidateConfigTaskState(restOperation);
        blockState = configTaskState.block;
        logger.fine("MSDA: onPost, inputProperties ", blockState.inputProperties);
        logger.fine("MSDA: onPost, dataProperties ", blockState.dataProperties);
        logger.fine("MSDA: onPost, instanceName ", blockState.name);
        inputProperties = blockUtil.getMapFromPropertiesAndValidate(
          blockState.inputProperties,
          ["zkEndpoint", "applicationType", "serviceName", "poolName", "poolType", "healthMonitor"]
        );
        dataProperties = blockUtil.getMapFromPropertiesAndValidate(
            blockState.dataProperties,
            ["pollInterval"]
        );
        instanceName = blockState.name;
    } catch (ex) {
        restOperation.fail(ex);
        return;
    }

    // Mark that the request meets all validity checks and tell the originator it was accepted.
    this.completeRequest(restOperation, this.wellKnownPorts.STATUS_ACCEPTED);

    // Generic URI components, minus the 'path'
    var uri = this.restHelper.buildUri({
        protocol: this.wellKnownPorts.DEFAULT_HTTP_SCHEME,
        port: this.wellKnownPorts.DEFAULT_JAVA_SERVER_PORT,
        hostname : "localhost"
    });

    //Accept input proterties, set the status to BOUND.

    var inputEndPoint = inputProperties.zkEndpoint.value;
    const inputApplicationType = inputProperties.applicationType.value;
    const inputServiceName = inputProperties.serviceName.value;
    const inputPoolName = inputProperties.poolName.value;
    const inputPoolType = inputProperties.poolType.value;
    const inputMonitor = inputProperties.healthMonitor.value;
    var pollInterval = dataProperties.pollInterval.value * 1000;
    const watchDuration = pollInterval - 1000;

    // Check the existence of the pool in BIG-IP, create an empty pool if the pool doesn't exist.
    mytmsh.executeCommand("tmsh -a list ltm pool " + inputPoolName)
    .then(function () {
        logger.fine(
            "MSDA: onPost, " +
            instanceName +
            " found the pool, no need to create an initial empty pool, but update the pool configure."
        );
        let inputExistingPoolConfig = inputPoolName + ' monitor ' + inputMonitor + ' load-balancing-mode ' + inputPoolType;
        let commandModifyPool = 'tmsh -a modify ltm pool ' + inputExistingPoolConfig;
        return mytmsh.executeCommand(commandModifyPool);
    }, function (error) {
        logger.fine(
            "MSDA: onPost, " +
            instanceName +
            " GET of pool failed, adding an initial empty pool: " +
            inputPoolName
        );
        let inputEmptyPoolConfig = inputPoolName + ' monitor ' + inputMonitor + ' load-balancing-mode ' + inputPoolType + ' members none';
        let commandCreatePool = 'tmsh -a create ltm pool ' + inputEmptyPoolConfig;
        return mytmsh.executeCommand(commandCreatePool);
    })
    .catch(function (error) {
        logger.fine(
            "MSDA: onPost, " + instanceName + " list pool failed: ",
            error.message
        );
    });


    // Set the polling interval
    if (pollInterval) {
        if (pollInterval < 10000) {
            logger.fine(
                "MSDA: onPost, " +
                instanceName +
                " pollInternal is too short, will set it to 10s ",
                pollInterval
            );
            pollInterval = 10000;
        }
    } else {
        logger.fine(
            "MSDA: onPost, " +
            instanceName +
            " pollInternal is not set, will set it to 30s ",
            pollInterval
        );
        pollInterval = 30000;
    }
    
    // Setup the polling signal for audit and update
    let blockInstance = {
        name: instanceName,
        bigipPool: inputPoolName,
        // Add signal for bigip pool change update
        bigipPoolChange: false,
        state: "polling"
    };

    let signalIndex = global.msdazkOnPolling.findIndex(instance => instance.name === instanceName);
    if (signalIndex !== -1) {
        //Already has the instance, set the pool change signal if the pool changed
        blockInstance.bigipPoolChange =
            global.msdazkOnPolling[signalIndex].bigipPool !== inputPoolName;

        // Already has the instance, change the state into "update"
        global.msdazkOnPolling.splice(signalIndex, 1);
        blockInstance.state = "update";
    }
    logger.fine("MSDA: onPost, blockInstance:", blockInstance);

    // Setup a signal to identify existing polling loop
    var existingPollingLoop = false;

    // Check if there is a conflict bigipPool in configuration

    if (
        global.msdazkOnPolling.some(
            (instance) => instance.bigipPool === inputPoolName
        )
    ) {
        logger.fine(
            "MSDA: onPost, " +
            instanceName +
            " already has an instance polling the same pool, change BLOCK to ERROR: ",
            inputPoolName
        );
        try { 
            throw new Error("onPost: poolName conflict: " + inputPoolName + " , will set the BLOCK to ERROR state");
        } catch (error) {
            configTaskUtil.sendPatchToErrorState(
              configTaskState,
              error,
              oThis.getUri().href,
              restOperation.getBasicAuthorization()
            );
        }
        return;
    } else {
        global.msdazkOnPolling.push(blockInstance);
        logger.fine(
            "MSDA onPost: " + instanceName + " set msdazkOnpolling signal: ",
            global.msdazkOnPolling
        );
    }

    /*
    try {
        logger.fine("MSDAzk: onPost, will set the polling signal. ");
        fs.writeFile(msdazkOnPollingSignal, '');
    } catch (error) {
        logger.fine("MSDAzk: onPost, hit error while set polling signal: ", error.message);
    }
    */

    logger.fine(
        "MSDA: onPost, " +
        instanceName +
        " Input properties accepted, change to BOUND status, start to poll Registry for: ",
        inputPoolName
    );

    configTaskUtil.sendPatchToBoundState(configTaskState, 
            oThis.getUri().href, restOperation.getBasicAuthorization());

    // A internal service to retrieve service member information from registry, and then update BIG-IP setting.

    //inputEndPoint = inputEndPoint.toString().split(","); 
    logger.fine(
        "MSDA: onPost, " + instanceName + " registry endpoints: ",
        inputEndPoint
    );

    // Define functions compare pool members

    function getPoolMembers(result) {
      const lines = result.split("\n");
      let poolMembers = [];
      lines.forEach((line, i) => {
        if (line.indexOf("address") > -1) {
          let memberLine = lines[i - 1];
          memberLine = memberLine.trim();
          memberLine = memberLine.split(" ");
          poolMembers.push(memberLine[0]);
        }
      });
      return poolMembers;
    }

    function compareArray(array1, array2) {
      return (
        array1.length === array2.length &&
        array1.every((item) => array2.indexOf(item) > -1)
      );
    }

    // Poll the change of the service, list all end-points and inject into F5.
    function listChildren(zkClient, inputServiceName) {
        zkClient.getChildren(
            inputServiceName,
            function (event) {
                logger.fine("MSDA: onPost, Got watcher event: %s", event);
                listChildren(zkClient, inputServiceName);
            },
            function (error, children, stat) {
                if (error) {
                    logger.fine(
                        "MSDA: onPost, " + instanceName + " Failed to list children of node: %s due to: %s. ",
                        inputServiceName,
                        error
                    );
                    if (error.getCode() == zookeeper.Exception.NO_NODE) {
                        //To clear the pool
                        logger.fine(
                            "MSDA: onPost, " +
                            instanceName +
                            " endpoint list is empty, will clear the BIG-IP pool as well"
                        );
                        mytmsh.executeCommand("tmsh -a list ltm pool " + inputPoolName)
                            .then(function (result) {
                                // Get pool members from list result
                                let poolMembersArray = getPoolMembers(result);
                                logger.fine(
                                    "MSDA: onPost, " +
                                    instanceName +
                                    " found the pool, will delete all members as it's empty.",
                                    poolMembersArray
                                );

                                if (poolMembersArray.length == 0) {
                                    return logger.fine(
                                      "MSDA: onPost, " +
                                        instanceName +
                                        " Existing pool has the same member list as service registry, will not update the BIG-IP config. ",
                                      inputPoolName
                                    );
                                } else {
                                    logger.fine(
                                      "MSDA: onPost, " +
                                        instanceName +
                                        " Existing pool has the different member list compare to service registry, will update the BIG-IP config. ",
                                      inputPoolName
                                    );
                                    let commandUpdatePool = 'tmsh -a modify ltm pool ' + inputPoolName + ' members delete { all}';
                                    return mytmsh
                                      .executeCommand(commandUpdatePool)
                                      .then(function () {
                                        logger.fine(
                                          "MSDA: onPost, " +
                                            instanceName +
                                            " update the pool to delete all members as it's empty. "
                                        );
                                      });
                                }
                            }, function () {
                                logger.fine(
                                    "MSDA: onPost, " +
                                    instanceName +
                                    " GET of pool failed, adding an empty pool: " +
                                    inputPoolName
                                );
                                let inputEmptyPoolConfig = inputPoolName +
                                    ' monitor ' +
                                    inputMonitor +
                                    ' load-balancing-mode ' +
                                    inputPoolType +
                                    ' members none';
                                let commandCreatePool = 'tmsh -a create ltm pool ' + inputEmptyPoolConfig;
                                return mytmsh.executeCommand(commandCreatePool);
                            })
                                // Error handling
                            .catch(function (error) {
                                logger.fine(
                                    "MSDA: onPost, " +
                                    instanceName +
                                    " Delete failed: " +
                                    error.message
                                );
                            });
                    }
                } else {
                    logger.fine(
                        "MSDA: onPost, " + instanceName + " Children of node: %s are: %j.",
                        inputServiceName,
                        children
                    );
                    // Configure the children into BIG-IP
                    if (children) {
                        // Parse the host information(ip:port) based on the application type
                        // Format the node information into pool members form
                        let nodeAddress = [];
                        switch (inputApplicationType) {
                            case "dcits-dubbo":
                                logger.fine(
                                  "MSDA: onPost, " +
                                    instanceName +
                                    " Application Type: ",
                                  inputApplicationType
                                );
                                //let nodeAddress = [];
                                children.forEach((element) => {
                                    nodeAddress.push(
                                      url.parse(urlencode.decode(element)).host
                                    );
                                });
                                //poolMembers = "{" + nodeAddress.join(" ") + "}";
                                break;
                            default:
                                nodeAddress = children;
                                //poolMembers = "{" + children.join(" ") + "}";
                        }
                        logger.fine(
                            "MSDA: onPost, " +
                            instanceName +
                            " service endpoint list: ",
                            nodeAddress
                        );
                        poolMembers = "{" + nodeAddress.join(" ") + "}";

                        logger.fine(
                            "MSDA: onPost, " +
                            instanceName +
                            " pool members: " +
                            poolMembers
                        );
                        let inputPoolConfig = inputPoolName +
                            ' monitor ' +
                            inputMonitor +
                            ' load-balancing-mode ' +
                            inputPoolType +
                            ' members replace-all-with ' +
                            poolMembers;

                        // Use tmsh to update BIG-IP configuration instead of restful API

                        // Start with check the exisitence of the given pool
                        mytmsh.executeCommand("tmsh -a list ltm pool " + inputPoolName).then(function (result) {

                            // Get pool members from list result
                            let poolMembersArray = getPoolMembers(result);
                            logger.fine(
                                "MSDA: onPost, " +
                                instanceName +
                                " Found a pre-existing pool: " +
                                inputPoolName + " has members: ",
                                poolMembersArray
                            );

                            if (compareArray(nodeAddress, poolMembersArray)) {
                                return logger.fine(
                                  "MSDA: onPost, " +
                                    instanceName +
                                    " Existing pool has the same member list as service registry, will not update the BIG-IP config. ",
                                    inputPoolName
                                );
                            } else {
                                logger.fine(
                                  "MSDA: onPost, " +
                                    instanceName +
                                    " Existing pool has the different member list compare to service registry, will update the BIG-IP config. ",
                                  inputPoolName
                                );

                                // Find the difference between registry and big-ip config, update on Mar/09/2023 by Ping Xiong
                                const toAdd = nodeAddress.filter(
                                  (x) => !poolMembersArray.includes(x)
                                );
                                const toDelete = poolMembersArray.filter(
                                  (x) => !nodeAddress.includes(x)
                                );

                                if (toAdd.length !== 0) { 
                                    // Add pool members
                                    const poolMembersToAdd = "{" + toAdd.join(" ") + "}";
                                    const commandAddPoolMember = "tmsh -a modify ltm pool " + inputPoolName + ' members add ' + poolMembersToAdd;
                                    return mytmsh.executeCommand(commandAddPoolMember);
                                };

                                if (toDelete.length !== 0) {
                                    // Delete pool members
                                    const poolMembersToDelete = "{" + toDelete.join(" ") + "}";
                                    const commandDeletePoolMember = "tmsh -a modify ltm pool " + inputPoolName + ' members delete ' + poolMembersToDelete;
                                    return mytmsh.executeCommand(commandDeletePoolMember);
                                };
                                
                                //let commandUpdatePool = "tmsh -a modify ltm pool " + inputPoolConfig;
                                //return mytmsh.executeCommand(commandUpdatePool);
                            }
                        }, function (error) {
                            logger.fine("MSDA: onPost, GET of pool failed, adding from scratch: " + inputPoolName);
                            let commandCreatePool = 'tmsh -a create ltm pool ' + inputPoolConfig;
                            return mytmsh.executeCommand(commandCreatePool);
                        })
                            // Error handling
                            .catch(function (error) {
                                logger.fine(
                                    "MSDA: onPost, " +
                                    instanceName +
                                    " Add Failure: adding/modifying a pool: ",
                                    error.message
                                );
                            });
                    }
                }
            }
        );
    }

    // Create zkclient to the registry for the initial polling
    var zkClient = zookeeper.createClient(inputEndPoint,
        {
            sessionTimeout: pollInterval,
            retries: dataProperties.pollInterval.value
        });
    zkClient.connect();
    zkClient.once("connected", function(){
        logger.fine(
            "MSDA: onPost, " +
              instanceName +
              " registry connected, initial polling, will retrieve service end-points for ",
            inputPoolName
          );
        listChildren(zkClient, inputServiceName);
    });
    // close the connection after the pollInterval
    setTimeout(function () {
        zkClient.close();
        logger.fine(
          "MSDA: onPost, " +
            instanceName +
            " registry initial polling connection closed for ",
          inputServiceName
        );
    }, watchDuration);


    // Start the loop to poll the zookeeper service
    (function schedule() {
        var pollRegistry = setTimeout(function () {
            // Check if the signal is "polling"
            // If signal is "update", change it into "polling" for new polling loop
            if (global.msdazkOnPolling.some(instance => instance.name === instanceName)) {
                let signalIndex = global.msdazkOnPolling.findIndex(instance => instance.name === instanceName);
                if (global.msdazkOnPolling[signalIndex].state === "update") {
                    if (existingPollingLoop) {
                        logger.fine(
                            "MSDA: onPost/polling, " +
                            instanceName +
                            " update config, existing polling loop."
                        );
                    } else {
                        //logger.fine("MSDA: onPost/polling, " + instanceName + " update config, a new polling loop.");
                        global.msdazkOnPolling[signalIndex].state = "polling";
                        logger.fine(
                            "MSDA: onPost/polling, " +
                            instanceName +
                            " update the signal.state into polling for new polling loop: ",
                            global.msdazkOnPolling[signalIndex]
                        );
                    }
                }
                // update the existingPollingLoop to true
                existingPollingLoop = true;
            } else {
                // Non-exist instance, will NOT proceed to poll the registry
                return logger.fine(
                    "MSDA: onPost/polling, " +
                    instanceName +
                    " Stop polling registry."
                );
            }

            // Start to poll the zk registry in the main loop ...
            var zkClient = zookeeper.createClient(inputEndPoint, {
                sessionTimeout: pollInterval,
                retries: dataProperties.pollInterval.value
            });
            zkClient.connect();
            /* Using .once to avoid the issue of multiple connected event fired. No need to use removeListener.
            const timeoutDuration = 5000; // Set 5s timeout for connected event.
            const timeout = setTimeout(() => {
                logger.fine(
                  "MSDA: onPost, " +
                    instanceName +
                    " fail to connect to the registry, will remove the connected listener."
                );;
                // Remove the listener
                zkClient.removeListener("connected", connectedListener);
            }, timeoutDuration);
            

            // Define the listener
            function connectedListener() {
                logger.fine(
                  "MSDA: onPost, " +
                    instanceName +
                    " registry connected, will retrieve service end-points for ",
                  inputPoolName
                );
                listChildren(zkClient, inputServiceName);
                zkClient.close();
                logger.fine(
                  "MSDA: onPost, " +
                    instanceName +
                    " registry connection closed for ",
                  inputServiceName
                );
                // No need to remove the listener
                //clearTimeout(timeout); // Clear timer
            }
            */

            zkClient.once("connected", function () {
                logger.fine(
                    "MSDA: onPost, " +
                      instanceName +
                      " registry connected, main polling loop, will retrieve service end-points for ",
                    inputPoolName
                  );
                listChildren(zkClient, inputServiceName);
            });

            // close the connection after the pollInterval
            setTimeout(function () {
                zkClient.close();
                logger.fine(
                  "MSDA: onPost, " +
                    instanceName +
                    " registry main polling connection closed for ",
                  inputServiceName
                );
            }, watchDuration);

            schedule(); // How to handle potential overlapping issue?
        }, pollInterval);

        // stop polling while undeployment or update the config

        let stopPolling = true;

        if (
            global.msdazkOnPolling.some(
                (instance) => instance.name === instanceName
            )
        ) {
            let signalIndex = global.msdazkOnPolling.findIndex(
                (instance) => instance.name === instanceName
            );
            if (global.msdazkOnPolling[signalIndex].state === "polling") {
                logger.fine(
                    "MSDA: onPost, " +
                    instanceName + " keep polling registry for: ",
                    inputServiceName
                );
                stopPolling = false;
            } else {
                // state = "update", stop polling for existing loop; trigger a new loop for new one.
                if (existingPollingLoop) {
                    logger.fine(
                        "MSDA: onPost, " +
                        instanceName +
                        " update config, will terminate existing polling loop."
                    );
                } else {
                    logger.fine(
                        "MSDA: onPost, " +
                        instanceName +
                        " update config, will trigger a new polling loop."
                    );
                    stopPolling = false;
                }
            }
        }

        if (stopPolling) {
            process.nextTick(() => {
                clearTimeout(pollRegistry);
                logger.fine(
                    "MSDA: onPost/stopping, " +
                    instanceName +
                    " Stop polling registry for: ",
                    inputServiceName
                );
            });
            // Delete pool configuration if the pool name changed.

            if (
                global.msdazkOnPolling.some(
                    (instance) => instance.name === instanceName
                )
            ) {
                let signalIndex = global.msdazkOnPolling.findIndex(
                    (instance) => instance.name === instanceName
                );
                if (global.msdazkOnPolling[signalIndex].bigipPoolChange === true) {
                    logger.fine(
                    "MSDA: onPost, " +
                        instanceName +
                        " BigipPool Changed, will delete previous pool for : ",
                    inputServiceName
                    );

                    setTimeout (function () {
                        const commandDeletePool = 'tmsh -a delete ltm pool ' + inputPoolName;
                        mytmsh.executeCommand(commandDeletePool)
                        .then (function () {
                            logger.fine(
                                "MSDA: onPost/stopping, " +
                                instanceName +
                                " the pool removed: " +
                                inputPoolName
                            );
                        })
                            // Error handling
                        .catch(function (err) {
                            logger.fine(
                                "MSDA: onPost/stopping, " +
                                instanceName +
                                " Delete failed: " +
                                inputPoolName,
                                err.message
                            );
                        }).done(function () {
                            global.msdazkOnPolling[signalIndex].bigipPoolChange = false;
                            return logger.fine(
                                "MSDA: onPost/stopping, " +
                                instanceName +
                                " exit loop."
                            );
                        });
                    }, 2000);
                };
            }
        }
    })();
};


/**
 * Handles DELETE. The configuration must be removed, if it exists. Patch the block to 'UNBOUND' or 'ERROR'
 *
 * @param restOperation - originating rest operation that triggered this processor
 */
msdazkConfigProcessor.prototype.onDelete = function (restOperation) {
    var configTaskState,
        blockState;
    var oThis = this;

    logger.fine("MSDA: onDelete, msdazkConfigProcessor.prototype.onDelete");

    var instanceName;
    var inputProperties;
    try {
        configTaskState = configTaskUtil.getAndValidateConfigTaskState(restOperation);
        blockState = configTaskState.block;
        inputProperties = blockUtil.getMapFromPropertiesAndValidate(blockState.inputProperties,
            ["poolName", "poolType"]);
        instanceName = blockState.name;
    } catch (ex) {
        restOperation.fail(ex);
        return;
    }
    this.completeRequest(restOperation, this.wellKnownPorts.STATUS_ACCEPTED);

    // Generic URI components, minus the 'path'
    var uri = this.restHelper.buildUri({
        protocol: this.wellKnownPorts.DEFAULT_HTTP_SCHEME,
        port: this.wellKnownPorts.DEFAULT_JAVA_SERVER_PORT,
        hostname: "localhost"
    });

    // In case user requested configuration to deployed to remote
    // device, setup remote hostname, HTTPS port and device group name
    // to be used for identified requests

    // Delete the polling signal first, then remove the pool in bigip
    let signalIndex = global.msdazkOnPolling.findIndex(
      (instance) => instance.name === instanceName
    );
    global.msdazkOnPolling.splice(signalIndex, 1);
    logger.fine(
      "MSDA: onDelete, " +
        instanceName +
        " deleted polling signal!!! Continue to remove the pool in bigip."
    );
    // Use tmsh to update configuration

    mytmsh.executeCommand("tmsh -a list ltm pool " + inputProperties.poolName.value)
        .then(function () {
            logger.fine(
                "MSDA: onDelete, " +
                instanceName +
                " delete Found a pre-existing pool. Full Config Delete: ",
                inputProperties.poolName.value
            );
            const commandDeletePool = 'tmsh -a delete ltm pool ' + inputProperties.poolName.value;
            return mytmsh.executeCommand(commandDeletePool)
            .then (function (response) {
                logger.fine(
                    "MSDA: onDelete, " +
                    instanceName +
                    " delete The pool is all removed: ",
                    inputProperties.poolName.value
                );
                configTaskUtil.sendPatchToUnBoundState(configTaskState,
                    oThis.getUri().href, restOperation.getBasicAuthorization());
                });
        }, function (error) {
            // the configuration must be clean. Nothing to delete
            logger.fine(
                "MSDA: onDelete, " + instanceName + " pool does't exist: ",
                error.message
            );
            configTaskUtil.sendPatchToUnBoundState(configTaskState, 
                oThis.getUri().href, restOperation.getBasicAuthorization());
        })
        // Error handling - Set the block as 'ERROR'
        .catch(function (error) {
            logger.fine(
                "MSDA: onDelete, " +
                instanceName +
                " Delete failed, setting block to ERROR: ",
                error.message
            );
            configTaskUtil.sendPatchToErrorState(configTaskState, error,
                oThis.getUri().href, restOperation.getBasicAuthorization());
        })
        // Always called, no matter the disposition. Also handles re-throwing internal exceptions.
        .done(function () {
            logger.fine(
                "MSDA: onDelete, " +
                instanceName +
                " Bigip configuration delete DONE!!!"
            );  // happens regardless of errors or no errors ....
            // Delete the polling signal
            //let signalIndex = global.msdazkOnPolling.findIndex(
            //  (instance) => instance.name === instanceName
            //);
            //global.msdazkOnPolling.splice(signalIndex,1);
        });    
    
    // Stop polling registry while undeploy ??
    //stopPolling = true;
    //stopPollingEvent.emit('stopPollingRegistry');
    //logger.fine("MSDA: onDelete, Stop polling Registry while ondelete action.");
};

module.exports = msdazkConfigProcessor;
