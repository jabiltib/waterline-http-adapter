'use strict';

var Helper  = require('./http-helper'),
    util    = require('util'),
    _       = require('lodash'),
    log     = require('./log');


function remoteError(err, connection, response, result) {
    var responseCode = null;
    if (response && response.statusCode) responseCode = response.statusCode;

    return {
        message: 'An error occurred for remote host.',
        statusCode: responseCode,
        source: connection.identity,
        error: err
    };
}

module.exports = (function () {
    var connections = {};
    var _collections = {};

    var adapter = {
        syncable: false,

        defaults: {},

        registerConnection: function(connection, collections, cb) {
            if(!connection.identity) return cb(new Error('Connection is missing an identity.'));
            if(connections[connection.identity]) return cb(new Error('Connection is already registered.'));

            _.keys(collections).forEach(function(key) {
            _collections[key] = collections[key];
            });

            connection.legacyOdataSupport = (connection.legacyOdataSupport && connection.legacyOdataSupport === true || connection.legacyOdataSupport === 'true')

            connections[connection.identity] = connection;
            cb();
        },

        teardown: function (conn, cb) {
          cb();
        },

        /**
         * The main function for the adapter, all calls will be made through this function.
         * @param {string} identity - The connection to be used. SUPPLIED BY WATERLINE.
         * @param {string} collection - The collection using this adapter. SUPPLIED BY WATERLINE.
         * @param {string} actionName - The name of the action in the model's configuration to use, e.g. 'create' or 'update', etc.
         * @param {Object} urlParams - A collection of key:value parameters appended to the query string in the URL.
         * @param {Object} values - Used for post/put methods, values represent the object or objects being posted to the remote server
         *                          and are used to create the outgoing request's body.
         * @param {Object} context - An object containing context specific values used for interpolation, e.g. session, currentUser, request
         *                           params, etc.
         * @param {requestCallback} cb - The callback handler used when the request is finished.
         */
        request: function(identity, collection, actionName, urlParams, values, context, cb) {
            var connection = connections[identity];
            var model = _collections[collection];
            // Clone action config so any changes made by user in callbacks doesn't affect
            // future calls.
            var action = _.cloneDeep(model.http[actionName]);

            if(!action) return cb(new Error(util.format('No HTTP adapter action "%s" configuration for model "%s".', actionName, model.identity)));

            var helper = new Helper(connection, model, action, urlParams, values, context);

            helper.makeRequest(function(err, response, result) {
                if (err) return cb(remoteError(err, connection, response, result));

               log('response received: ' + util.inspect({
                  status: response.statusCode,
                  configuration: action,
                  body: response.body
                }, { depth: null }));

                // Create model instances from the POJOs.
                var models = [];
                result.forEach(function(attributes) {
                  models.push(new model._model(attributes, {}));
                });

                return cb(null, models);
            });
        },
        identity: 'waterline-http'
    };

  return adapter;
})();
