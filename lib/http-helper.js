'use strict';

var mappers = require('./mappers'),
    parsers = require('./parsers'),
    ParseError = parsers.ParseError,
    URI = require('URIjs'),
    util = require('util'),
    request = require('request'),
    _ = require('lodash'),
    handlebars = require('handlebars'),
    log = require('./log'),
    co  = require('co');

var mimes = {
    'json': 'application/json',
    'xml': 'application/xml',
    'form-encoded': 'application/x-www-form-urlencoded'
};

var maps = {
    'json': mappers.JsonMapper,
    'xml': mappers.XmlMapper,
    'form_encoded': mappers.FormEncodedMapper
};

var payloadParsers = {
    'json': parsers.JsonParser,
    'xml': parsers.XmlParser
};

// Deserialize a base64 encoded cert
function deserializeCert(cert, encoding) {
    if (!cert) return undefined;
    if (!encoding) encoding = 'ascii';
    var b = new Buffer(cert, 'base64');
    return b.toString(encoding).replace(/\\n/gm, '\n');
}

function HttpHelper(connection, model, action, urlParams, values, context) {
    this.connection = connection;
    this.model = model;
    this.action = action;
    this.urlParams = urlParams;
    this.values = values;
    this.context = context;

    this.queryParams = (function() {
      var query = {};
      if (context.query && context.query.query && context.query.scope) query = context.query.query;
      return _.merge(action.defaultParams || {}, query);
    })();
}

HttpHelper.prototype.addTlsOptions = function(options) {
    var name = this.connection.name;
    if (!name) return;

    var pfx = process.env[name + '_SERIALIZED_PFX'];
    var key = process.env[name + '_SERIALIZED_PRIVATE_KEY'];
    var cert = process.env[name + '_SERIALIZED_CERT'];
    var passphrase = process.env[name + '_PASSPHRASE'];
    var caCert = process.env[name + '_SERIALIZED_CA_CERT'];

    if (pfx || key || cert || passphrase || caCert) options.agentOptions = {};

    if (pfx) options.agentOptions.pfx = deserializeCert(pfx);

    if (key) options.agentOptions.key = deserializeCert(key);

    if (cert) options.agentOptions.cert = deserializeCert(cert);

    if (caCert)  options.agentOptions.ca = deserializeCert(caCert);

    if (passphrase) options.agentOptions.passphrase = passphrase;
};

HttpHelper.prototype.mapResponse = function(payload, cb) {
    var self = this;
    var mapper = maps[self.action.format](self.model, self.action, self.context);
    mapper.mapResponse(payload, cb);
};

HttpHelper.prototype.mapRequest = function(cb) {
    var self = this;
    var mapper = maps[self.action.format](self.model, self.action, self.context);
    mapper.mapRequest(self.values, cb);
};

HttpHelper.prototype.constructBody = function(cb) {
    var self = this;

    // If action has a body template, construct and return it.
    if (self.action.bodyPayloadTemplate && !_.isEmpty(self.action.bodyPayloadTemplate)) {
        return cb(null, self.interpolate(self.action.bodyPayloadTemplate));
    }

    // If we have no body template result and the values supplied are empty,
    // return nothing.
    if (_.isEmpty(self.values)) return cb();

    self.mapRequest(function(err, res) {
        if (err) return cb(err);

        if (self.action.format === 'json') return cb(null, JSON.stringify(res));
        return cb(null, res);
    });
};

HttpHelper.prototype.mapQueryParams = function() {
    var self = this;

    var q = {},
        map = self.action.mapping.request,
        keys = _.keys(self.queryParams);

    if (keys.length === 0) return q;

    keys.forEach(function(key) {
        var mappedKey = map[key];
        if (mappedKey) q[mappedKey] = self.queryParams[key];
    });

    return q;
};

HttpHelper.prototype.constructHeaders = function() {
    var self = this;

    var headers = {};

    /* Content negotiation headers
       The action configuration takes precedence over the adapter configuration,
       except when the action is form-encoded. When an outoing request is set
       to form-encoded, it falls back to the adapter level configuration
       for the Accept header.

       If the action doesn't have a format defined, fallback to the adapter
       connection format.
    */
    headers['Content-Type'] = headers['Accept'] = mimes[self.action.format || self.connection.format];
    if (self.action.format === 'form-encoded') headers['Accept'] = mimes[self.connection.format];

    // Basic auth header construction
    if (self.connection.username && self.connection.passwordPlainText) {
        var buffer = new Buffer(self.interpolate(self.connection.username) + ':' + self.interpolate(self.connection.passwordPlainText));
        headers['Authorization'] = 'Basic ' + buffer.toString('base64');
    }

    // Merge all headers, action headers take precedence over adapter/connection headers
    headers = _.merge(headers, _.cloneDeep(self.connection.headers), _.cloneDeep(self.action.headers));

    _.keys(headers).forEach(function(key) {
        headers[key] = self.interpolate(headers[key]);
    });

    return headers;
};

HttpHelper.prototype.constructUri = function() {
    var self = this;
    var _baseUri = self.interpolate(self.connection.baseUri);
    var url = new URI(_baseUri);
    var actionPath = self.action.path;

    if (url.path(true).length > 0 && url.path(true) !== '/') {
        actionPath = url.path(true) + actionPath;
    }

    url.path(self.interpolate(actionPath));
             
    var allParams = _.merge(_.cloneDeep(this.connection.urlParameters),
                    _.cloneDeep(this.action.urlParameters) || {},
                    _.cloneDeep(this.urlParams) || {},
                    this.mapQueryParams());

    _.keys(allParams).forEach(function(key) {
        allParams[key] = self.interpolate(allParams[key]);
    });

    if (!_.isEmpty(allParams)) url.addQuery(allParams);

    if (this.connection.legacyOdataSupport) return URI.encodeReserved(URI.decode(url.toString()));

    return url.toString();
};

HttpHelper.prototype.interpolate = function(source) {
    if (!source) return '';
    if (!_.isString(source)) source = source.toString();
    if (source.indexOf('{{') === -1) return source;

    var template = handlebars.compile(source);
    return template(this.context);
};

HttpHelper.prototype.makeRequest = function(cb) {
    var self = this;

    self.constructBody(co.wrap(function*(err, res) {
        if (err) return cb(err);

        var params = {
            url: self.constructUri(),
            headers: self.constructHeaders(),
            method: self.action.verb,
            body: res || ''
        };

        // Check for user hook
        if (self.connection.beforeRawRequest) yield self.connection.beforeRawRequest(params);

        self.addTlsOptions(params);

        log('request made with options: ' + util.inspect(
            {
                params:params,
                configuration: self.action
            },
            { depth: null }));

        request(params, function(err, response, result) {
            if (err) return cb(err, response, result);

            co.wrap(function*() {
                if (self.connection.afterRawResponse) yield self.connection.afterRawResponse(response);
            })();

            var parsedResponse = null;
            var parseError = null;

            // get the parsed response
            try {
                var action = self.action.format;
                if (action === 'form_encoded') action = self.connection.format;
                parsedResponse = payloadParsers[action]().parse(result);
            } catch(e) {
                if (e.constructor === ParseError) {
                    parseError = e;
                } else {
                    return cb(e, response, result);
                }
            }

            if (response.statusCode >= 200 && response.statusCode < 300) {
                if (self.action.pathSelector === '') {
                    log('Object ' + self.action.objectNameMapping + 'has no response selector configured for ' +
                        self.action.verb + ':' + self.action.path + '. Ignoring response body.');
                    return cb(null, response, []);
                }

                // if no parse error, but the parser returned back null, reply with an empty array since there's nothing to return
                if (parseError === null && parsedResponse === null) {
                    return cb(err, response, []);
                } else {
                    self.mapResponse(parsedResponse, function(err, mappedResult) {
                        return cb(err, response, mappedResult);
                    });
                }
            } else {
                var e = {
                    message: 'Remote host returned ' + response.statusCode,
                    statusCode: response.statusCode,
                    adapter: self.connection.adapter,
                    responseBody: response.body,
                    responseHeaders: response.headers,
                    parsedResponseBody: parsedResponse
                };
                return cb(e, response, result);
            }
        });
    }))
    .catch(cb);
};



module.exports = HttpHelper;
