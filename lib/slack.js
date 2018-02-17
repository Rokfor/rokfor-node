
module.exports = function(config, log) {

  /* Central Data Structure */

  const sl_webhook = require('@slack/client').IncomingWebhook,
        sl_url     = config.slack_hook || false,
        slack      = sl_url ? new sl_webhook(sl_url) : false;
 

  module.notify = function(msg) {
    if (slack) {
      slack.send(msg, function(err, header, statusCode, body) {
        if (err) {
          log.error(`  - Slack Connection failed ${err}`);
        } else {
          log.info(`  - Slack Connection ok ${statusCode}`);
        }
      });
    }
  }

  return module;
}