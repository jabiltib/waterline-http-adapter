module.exports = {
    connection: 'test',
    autoCreatedAt: false,
    autoUpdatedAt: false,
    attributes: {
        id: {
            type: 'integer'
        },
        desc: {
            type: 'text'
        },
        value: {
            type: 'integer'
        },
        longFieldName: {
            type: 'string'
        },
        ping: function() {
            return 'pong';
        }
    },
    http: {
        read: {
            verb: 'GET',
            path: '/api/V1/model',
            format: 'json',
            headers: {},
            urlParameters: {},
            objectNameMapping: 'v1model',
            pathSelector: '$.*',
            bodyPayloadTemplate: '',
            mapping: {
                response: {},
                request: {}
            }
        }
    }
};