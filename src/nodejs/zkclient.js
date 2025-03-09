var zookeeper = require('node-zookeeper-client');

var client = zookeeper.createClient('localhost:2181,localhost:2182,localhost:2183',{sessionTimeout: 30000, spinDelay: 1000, retries: 10});
var path = "/services/http";

function listChildren(client, path) {
    client.getChildren(
        path,
        function (event) {
            console.log('Got watcher event: %s', event);
            listChildren(client, path);
        },
        function (error, children, stat) {
            if (error) {
                console.log(
                    'Failed to list children of %s due to: %s.',
                    path,
                    error
                );
                return;
            }

            console.log('Children of %s are: %j.', path, children);
        }
    );
}

client.once('connected', function () {
    console.log('Connected to ZooKeeper.');
    listChildren(client, path);
    //client.close();
});

client.connect();

// set a timeout of 30 sexonds to close the connection
setTimeout(function () {
    console.log('Closing connection.');
    client.close();
}, 30000);

client.once('disconnected', function () {
    console.log('Disconnected from ZooKeeper.');
    //client.close();
});

// Cnnect to zookeeper again after 2 seconds
setTimeout(function () {
    console.log('Reconnecting to ZooKeeper.');
    client.connect();// Does not work.
}, 32000);

