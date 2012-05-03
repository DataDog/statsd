var dgram  = require('dgram')
  , util    = require('util')
  , net    = require('net')
  , config = require('./config')
  , fs     = require('fs')

var keyCounter = {};
var counters = {};
var timers = {};
var debugInt, flushInt, keyFlushInt, server, mgmtServer;
var startup_time = Math.round(new Date().getTime() / 1000);

var stats = {
  graphite: {
    last_flush: startup_time,
    last_exception: startup_time
  },
  datadog: {
    last_flush: null,
    last_exception: null,
  },
  messages: {
    last_msg_seen: startup_time,
    bad_lines_seen: 0,
  }
};

config.configFile(process.argv[2], function (config, oldConfig) {
  if (! config.debug && debugInt) {
    clearInterval(debugInt); 
    debugInt = false;
  }

  if (config.debug) {
    if (debugInt !== undefined) { clearInterval(debugInt); }
    debugInt = setInterval(function () { 
      util.log("Counters:\n" + util.inspect(counters) + "\nTimers:\n" + util.inspect(timers));
      if (config.datadogApiKey) {
        if (stats['datadog']['last_flush']) {
          util.log("Datadog - last flush: " + stats['datadog']['last_flush']);
        }
        if (stats['datadog']['last_exception']) {
          util.log("Datadog - last exception: " + stats['datadog']['last_exception']);
        }
      }
    }, config.debugInterval || 10000);
  }

  if (server === undefined) {

    // key counting
    var keyFlushInterval = Number((config.keyFlush && config.keyFlush.interval) || 0);

    server = dgram.createSocket('udp4', function (msg, rinfo) {
      if (config.dumpMessages) { util.log(msg.toString()); }
      var bits = msg.toString().split(':');
      var key = bits.shift()
                    .replace(/\s+/g, '_')
                    .replace(/\//g, '-')
                    .replace(/[^a-zA-Z_\-0-9\.]/g, '');

      if (keyFlushInterval > 0) {
        if (! keyCounter[key]) {
          keyCounter[key] = 0;
        }
        keyCounter[key] += 1;
      }

      if (bits.length == 0) {
        bits.push("1");
      }

      for (var i = 0; i < bits.length; i++) {
        var sampleRate = 1;
        var fields = bits[i].split("|");
        if (fields[1] === undefined) {
            util.log('Bad line: ' + fields);
            stats['messages']['bad_lines_seen']++;
            continue;
        }
        if (fields[1].trim() == "ms") {
          if (! timers[key]) {
            timers[key] = [];
          }
          timers[key].push(Number(fields[0] || 0));
        } else {
          if (fields[2] && fields[2].match(/^@([\d\.]+)/)) {
            sampleRate = Number(fields[2].match(/^@([\d\.]+)/)[1]);
          }
          if (! counters[key]) {
            counters[key] = 0;
          }
          counters[key] += Number(fields[0] || 1) * (1 / sampleRate);
        }
      }

      stats['messages']['last_msg_seen'] = Math.round(new Date().getTime() / 1000);
    });

    mgmtServer = net.createServer(function(stream) {
      stream.setEncoding('ascii');

      stream.on('data', function(data) {
        var cmdline = data.trim().split(" ");
        var cmd = cmdline.shift();

        switch(cmd) {
          case "help":
            stream.write("Commands: stats, counters, timers, delcounters, deltimers, quit\n\n");
            break;

          case "stats":
            var now    = Math.round(new Date().getTime() / 1000);
            var uptime = now - startup_time;

            stream.write("uptime: " + uptime + "\n");

            for (group in stats) {
              for (metric in stats[group]) {
                var val;

                if (metric.match("^last_")) {
                  val = now - stats[group][metric];
                }
                else {
                  val = stats[group][metric];
                }

                stream.write(group + "." + metric + ": " + val + "\n");
              }
            }
            stream.write("END\n\n");
            break;

          case "counters":
            stream.write(util.inspect(counters) + "\n");
            stream.write("END\n\n");
            break;

          case "timers":
            stream.write(util.inspect(timers) + "\n");
            stream.write("END\n\n");
            break;

          case "delcounters":
            for (index in cmdline) {
              delete counters[cmdline[index]];
              stream.write("deleted: " + cmdline[index] + "\n");
            }
            stream.write("END\n\n");
            break;

          case "deltimers":
            for (index in cmdline) {
              delete timers[cmdline[index]];
              stream.write("deleted: " + cmdline[index] + "\n");
            }
            stream.write("END\n\n");
            break;

          case "quit":
            stream.end();
            break;

          default:
            stream.write("ERROR\n");
            break;
        }

      });
    });

    server.bind(config.port || 8125, config.address || undefined);
    mgmtServer.listen(config.mgmt_port || 8126, config.mgmt_address || undefined);

    util.log("server is up");

    var flushInterval = Number(config.flushInterval || 10000);

    var pctThreshold = config.percentThreshold || 90;
    if (!Array.isArray(pctThreshold)) {
      pctThreshold = [ pctThreshold ]; // listify percentiles so single values work the same
    }

    flushInt = setInterval(function () {
      var statString = '';
      var ts = Math.round(new Date().getTime() / 1000);
      var numStats = 0;
      var key;
      var snapshotCounters = {}
      var snapshotTimers = {}

      for (key in counters) {
        snapshotCounters[key] = counters[key];
        counters[key] = 0
      }

      for (key in timers) {
        snapshotTimers[key] = timers[key];
        timers[key] = [];
      }

      for (key in snapshotCounters) {
        var value = snapshotCounters[key];
        var valuePerSecond = value / (flushInterval / 1000); // calculate "per second" rate

        statString += 'stats.'        + key + ' ' + valuePerSecond + ' ' + ts + "\n";
        statString += 'stats_counts.' + key + ' ' + value          + ' ' + ts + "\n";

        numStats += 1;
      }

      for (key in snapshotTimers) {
        if (snapshotTimers[key].length > 0) {
          var values = snapshotTimers[key].sort(function (a,b) { return a-b; });
          var count = values.length;
          var min = values[0];
          var max = values[count - 1];

          var mean = min;
          var maxAtThreshold = max;

          var message = "";

          var key2;

          for (key2 in pctThreshold) {
            var pct = pctThreshold[key2];
            if (count > 1) {
              var thresholdIndex = Math.round(((100 - pct) / 100) * count);
              var numInThreshold = count - thresholdIndex;
              var pctValues = values.slice(0, numInThreshold);
              maxAtThreshold = pctValues[numInThreshold - 1];

              // average the remaining timings
              var sum = 0;
              for (var i = 0; i < numInThreshold; i++) {
                sum += pctValues[i];
              }

              mean = sum / numInThreshold;
            }

            var clean_pct = '' + pct;
            clean_pct.replace('.', '_');
            message += 'stats.timers.' + key + '.mean_'  + clean_pct + ' ' + mean           + ' ' + ts + "\n";
            message += 'stats.timers.' + key + '.upper_' + clean_pct + ' ' + maxAtThreshold + ' ' + ts + "\n";
          }

          message += 'stats.timers.' + key + '.upper ' + max   + ' ' + ts + "\n";
          message += 'stats.timers.' + key + '.lower ' + min   + ' ' + ts + "\n";
          message += 'stats.timers.' + key + '.count ' + count + ' ' + ts + "\n";
          statString += message;

          numStats += 1;
        }
      }

      statString += 'statsd.numStats ' + numStats + ' ' + ts + "\n";
      
      // Graphite
      if (config.graphiteHost) {
        try {
          var graphite = net.createConnection(config.graphitePort, config.graphiteHost);
          graphite.addListener('error', function(connectionException){
            if (config.debug) {
              util.log(connectionException);
            }
          });
          graphite.on('connect', function() {
            this.write(statString);
            this.end();
            stats['graphite']['last_flush'] = Math.round(new Date().getTime() / 1000);
          });
        } catch(e){
          if (config.debug) {
            util.log(e);
          }
          stats['graphite']['last_exception'] = Math.round(new Date().getTime() / 1000);
        }
      }

      // Datadog
      if (config.datadogApiKey) {
          var now = parseInt(new Date().getTime() / 1000);
          var host = config.hostname || os.hostname();
          var payload = [];

	  // Send counters
          for (key in snapshotCounters) {
            var value = snapshotCounters[key];
            payload.push({
              metric: key,
              points: [[now, value]],
              type: "counter",
              host: host
            })
          }

	  // Compute timers and send
          for (key in snapshotTimers) {
            if (snapshotTimers[key].length > 0) {
              var pctThreshold = config.percentThreshold || 90;
              var values = snapshotTimers[key].sort(function (a,b) { return a-b; });
              var count = values.length;
              var min = values[0];
              var max = values[count - 1];

              var mean = min;
              var maxAtThreshold = max;

              if (count > 1) {
                var thresholdIndex = Math.round(((100 - pctThreshold) / 100) * count);
                var numInThreshold = count - thresholdIndex;
                values = values.slice(0, numInThreshold);
                maxAtThreshold = values[numInThreshold - 1];

                // average the remaining timings
                var sum = 0;
                for (var i = 0; i < numInThreshold; i++) {
                  sum += values[i];
                }

                mean = sum / numInThreshold;
              }

              payload.push({
                metric: key + '.mean',
                points: [[now, mean]],
                type: 'gauge',
                host: host
              })
              payload.push({
                metric: key + '.upper',
                points: [[now, max]],
                type: 'gauge',
                host: host
              })
              payload.push({
                metric: key + '.upper_' + pctThreshold,
                points: [[now, maxAtThreshold]],
                type: 'gauge',
                host: host
              })
              payload.push({
                metric: key + '.lower',
                points: [[now, min]],
                type: 'gauge',
                host: host
              })
              payload.push({
                metric: key + '.count',
                points: [[now, count]],
                type: 'gauge',
                host: host
              })
            }
          }

          new Datadog(config.datadogApiKey, {api_host: config.datadogApiHost}).metrics(payload);
      }

    }, flushInterval);

    if (keyFlushInterval > 0) {
      var keyFlushPercent = Number((config.keyFlush && config.keyFlush.percent) || 100);
      var keyFlushLog = (config.keyFlush && config.keyFlush.log) || "stdout";

      keyFlushInt = setInterval(function () {
        var key;
        var sortedKeys = [];

        for (key in keyCounter) {
          sortedKeys.push([key, keyCounter[key]]);
        }

        sortedKeys.sort(function(a, b) { return b[1] - a[1]; });

        var logMessage = "";
        var timeString = (new Date()) + "";

        // only show the top "keyFlushPercent" keys
        for (var i = 0, e = sortedKeys.length * (keyFlushPercent / 100); i < e; i++) {
          logMessage += timeString + " " + sortedKeys[i][1] + " " + sortedKeys[i][0] + "\n";
        }

        var logFile = fs.createWriteStream(keyFlushLog, {flags: 'a+'});
        logFile.write(logMessage);
        logFile.end();

        // clear the counter
        keyCounter = {};
      }, keyFlushInterval);
    }

  }
});

var http = require('http'),
    https = require('https'),
    url = require('url'),
    os = require('os');

function now() {
    return new Date().getTime()/1000;
}

var Datadog = function(api_key, options) {
    var options = options || {};

    this.api_key = api_key;

    this.api_host = options.api_host || 'https://app.datadoghq.com';
    this.host_name = options.host_name || os.hostname();

    this.pending_requests = 0;
}

Datadog.prototype.metrics = function(payload) {
    var client = this;
    var message = {
        series: payload
    };
    client._post('series', message);    
}

Datadog.prototype._post = function(controller, message) {
    var client = this;
    var body = JSON.stringify(message);

    var transport, transport;
    var parsed = url.parse(this.api_host);
    if (parsed.protocol == 'http:') {
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
        stats['datadog']['last_flush'] = Math.round(new Date().getTime() / 1000);
        client.pending_requests -= 1;
    });    
    req.on('error', function(e) {
      util.log('Skipping, cannot send data to Datadog: ' + e.message);
      stats['datadog']['last_exception'] = Math.round(new Date().getTime() / 1000);
      client.pending_requests -= 1;
     });

    client.pending_requests += 1;
    req.write(body);
    req.end();
}