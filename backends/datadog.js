/*
 * Flush stats to datadog (http://datadoghq.com/).
 *
 * To enable this backend, include 'datadog' in the backends
 * configuration array:
 *
 *   backends: ['datadog']
 *
 * This backend supports the following config options:
 *
 *   datadogApiKey: Your DataDog API key
 */

var net = require('net'),
   util = require('util'),
   os = require('os'),
   Datadog = require('../datadogApi');

var debug;

var flushInterval;

var hostname;

var datadogApiHost;
var datadogApiKey;

var datadogStats = {};

var post_stats = function datadog_post_stats(payload) {
   try {
      new Datadog(datadogApiKey, { api_host: datadogApiHost }).metrics(payload);

      datadogStats.last_flush = Math.round(new Date().getTime() / 1000);
   } catch(e){
      if (debug) {
         util.log(e);
      }

      datadogStats.last_exception = Math.round(new Date().getTime() / 1000);
   }
};

var flush_stats = function datadog_post_stats(ts, metrics) {
   var counters = metrics.counters;
   var gauges = metrics.gauges;
   var timers = metrics.timers;
   var pctThreshold = metrics.pctThreshold;

   var host = hostname || os.hostname();
   var payload = [];
   var value;

   var key;

   // Send counters
   for (key in counters) {
      value = counters[key];
      var valuePerSecond = value / (flushInterval / 1000); // calculate "per second" rate

      payload.push({
         metric: key,
         points: [[ts, valuePerSecond]],
         type: "gauge",
         host: host
      });
   }

   // Send gauges
   for (key in gauges) {
      value = gauges[key];

      payload.push({
         metric: key,
         points: [[ts, value]],
         type: "gauge",
         host: host
      });
   }

   // Compute timers and send
   for (key in timers) {
      if (timers[key].length > 0) {
         var values = timers[key].sort(function (a,b) { return a-b; });
         var count = values.length;
         var min = values[0];
         var max = values[count - 1];

         var mean = min;
         var maxAtThreshold = max;
         var i;

         if (count > 1) {
            var thresholdIndex = Math.round(((100 - pctThreshold) / 100) * count);
            var numInThreshold = count - thresholdIndex;
            var pctValues = values.slice(0, numInThreshold);
            maxAtThreshold = pctValues[numInThreshold - 1];

            // average the remaining timings
            var sum = 0;
            for (i = 0; i < numInThreshold; i++) {
               sum += pctValues[i];
            }

            mean = sum / numInThreshold;
         }

         payload.push({
            metric: key + '.mean',
            points: [[ts, mean]],
            type: 'gauge',
            host: host
         });

         payload.push({
            metric: key + '.upper',
            points: [[ts, max]],
            type: 'gauge',
            host: host
         });

         payload.push({
            metric: key + '.upper_' + pctThreshold,
            points: [[ts, maxAtThreshold]],
            type: 'gauge',
            host: host
         });

         payload.push({
            metric: key + '.lower',
            points: [[ts, min]],
            type: 'gauge',
            host: host
         });

         payload.push({
            metric: key + '.count',
            points: [[ts, count]],
            type: 'gauge',
            host: host
         });
      }
   }

   post_stats(payload);
};

var backend_status = function datadog_status(writeCb) {
   var stat;

   for (stat in datadogStats) {
      writeCb(null, 'datadog', stat, datadogStats[stat]);
   }
};

exports.init = function datadog_init(startup_time, config, events) {
   debug = config.debug;
    

   hostname = config.hostname;

   datadogApiKey = config.datadogApiKey;
   datadogApiHost = config.datadogApiHost;

   if (!datadogApiHost) {
      datadogApiHost = 'https://app.datadoghq.com';
   }

   datadogStats.last_flush = startup_time;
   datadogStats.last_exception = startup_time;

   flushInterval = config.flushInterval;

   events.on('flush', flush_stats);
   events.on('status', backend_status);

   return true;
};
