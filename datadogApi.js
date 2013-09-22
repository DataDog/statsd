var http = require('http'),
   https = require('https'),
   util = require('util'),
   url = require('url'),
   os = require('os');

var Datadog = function(api_key, options) {
   options = options || {};

   this.api_key = api_key;

   this.api_host = options.api_host || 'https://app.datadoghq.com';
   this.host_name = options.host_name || os.hostname();

   this.pending_requests = 0;
};

Datadog.prototype.metrics = function(payload) {
   var client = this;
   var message = {
      series: payload
   };

   client._post('series', message);
};

Datadog.prototype._post = function(controller, message) {
   var client = this;
   var body = JSON.stringify(message);

   var transport;
   var parsed = url.parse(this.api_host);

   if (parsed.protocol === 'http:') {
      transport = http;
      api_port = parsed.port || 80;
      util.log("Warning! You are about to send unencrypted metrics.");
   } else {
      transport = https;
      api_port = parsed.port || 443;
   }

   api_host = parsed.hostname;

   var req = transport.request({
      host: api_host,
      port: api_port,
      path: '/api/v1/' + controller + '?api_key=' + client.api_key,
      method: 'POST',
      headers: {
         "Host": client.api_host,
         "Content-Length": body.length,
         "Content-Type": "application/json"
      }
   },
   function(response) {
      client.pending_requests -= 1;
   });

   req.on('error', function(e) {
      util.log('Skipping, cannot send data to Datadog: ' + e.message);

      client.pending_requests -= 1;
   });

   client.pending_requests += 1;

   req.write(body);
   req.end();
};

module.exports = Datadog;
