# Basic Pool iAppLX

This iApp is an example of accessing iCRD, including an audit processor.  The iApp itself is very simple - it manages the members of a pool.

The audit processor wakes up every 30 seconds (configurable). If the pool has changed on the BigIP then the block is rebound, restoring the Big-IP to the previous configuration.

This iApp also demostrates usage of identified requests with custom HTTPS port when user specifies remote BIG-IP address and device-group name when configuring. In this configuration, Device trust with remote BIG-IP address should be established ahead of time before deploying iApp.

## Build (requires rpmbuild)

    $ npm run build

Build output is an RPM package
## Using IAppLX from BIG-IP UI
If you are using BIG-IP, install f5-iappslx-basic-pool RPM package using iApps->Package Management LX->Import screen. To create an application, use iApps-> Templates LX -> Application Services -> Applications LX -> Create screen. Default IApp LX UI will be rendered based on the input properties specified in basic pool IAppLX.

Pool name is mandatory when creating or updating iAppLX configuration. Optionally you can add any number of pool members.

## Using IAppLX from Container to configure BIG-IP [coming soon]

Run the REST container [TBD] with f5-iappslx-basic-pool IAppLX package. Pass in the remote BIG-IP to be trusted when starting REST container as environment variable.

Create an Application LX block with hostname, deviceGroupName, poolName, poolType and poolMembers as shown below.
Save the JSON to block.json and use it in the curl call

```json
{
  "name": "msdazk",
  "inputProperties": [
    {
      "id": "zkEndpoint",
      "type": "STRING",
      "value": "1.1.1.1:2181, 1.1.1.2:2181",
      "metaData": {
        "description": "zk endpoint list",
        "displayName": "zk endpoints",
        "isRequired": true
      }
    },
    {
      "id": "poolName",
      "type": "STRING",
      "value": "/Common/zkSamplePool",
      "metaData": {
        "description": "Pool Name to be created",
        "displayName": "BIG-IP Pool Name",
        "isRequired": true
      }
    },
    {
      "id": "poolType",
      "type": "STRING",
      "value": "round-robin",
      "metaData": {
        "description": "load-balancing-mode",
        "displayName": "Load Balancing Mode",
        "isRequired": true,
        "uiType": "dropdown",
        "uiHints": {
          "list": {
            "dataList": [
              "round-robin",
              "least-connections-member",
              "least-connections-node"
            ]
          }
        }
      }
    },
    {
      "id": "healthMonitor",
      "type": "STRING",
      "value": "none",
      "metaData": {
        "description": "Health Monitor",
        "displayName": "Health Monitor",
        "isRequired": true,
        "uiType": "dropdown",
        "uiHints": {
          "list": {
            "dataList": [
              "tcp",
              "udp",
              "http",
              "none"
            ]
          }
        }
      }
    },
    {
      "id": "serviceName",
      "type": "STRING",
      "value": "/services/http",
      "metaData": {
        "description": "Service name to be exposed",
        "displayName": "Service Name in registry",
        "isRequired": false
      }
    }
  ],
  "dataProperties": [
    {
      "id": "pollInterval",
      "type": "NUMBER",
      "value": 30,
      "metaData": {
        "description": "Interval of polling from BIG-IP to registry, 30s by default.",
        "displayName": "Polling Invertal",
        "isRequired": false
      }
    }
  ],
  "configurationProcessorReference": {
    "link": "https://localhost/mgmt/shared/iapp/processors/msdazkConfig"
  },
  "audit": {
    "intervalSeconds": 0,
    "policy": "NOTIFY_ONLY"
  },
  "configProcessorTimeoutSeconds": 30,
  "statsProcessorTimeoutSeconds": 15,
  "configProcessorAffinity": {
    "processorPolicy": "LOAD_BALANCED",
    "affinityProcessorReference": {
      "link": "https://localhost/mgmt/shared/iapp/processors/affinity/load-balanced"
    }
  },
  "state": "TEMPLATE"
}
```

Post the block REST container using curl. Note you need to be running REST container for this step
and it needs to listening at port 8433
```bash
curl -sk -X POST -d @block.json https://localhost:8443/mgmt/shared/iapp/blocks
```
