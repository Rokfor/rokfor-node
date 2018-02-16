/**
 *  Rokfor Node Connector
 *  ---------------------
 *
 *  Propagates Rokfor Database Changes to a CouchDB
 *
 **/

"use strict";

var 
    config      = require('./config/config.js'),
    express     = require('express'),
    app         = express(),
    bodyParser  = require('body-parser'),
    fs          = require('fs'),
    Log         = require('log'),
    cors        = require('cors'),
    log         = new Log(config.loglevel, fs.createWriteStream('my.log')),
    rfC         = require('./lib/connector.js')(config, log),
    pkg         = JSON.parse(fs.readFileSync('./package.json', 'utf8')),
    jsonParser  = bodyParser.json();

const 
    version = pkg.version,
    appname = "Rokfor Writer Server",
    state   = {
      error: "error",
      ok:    "ok"
    };


/* 
   Setup Up some express stuff 
*/

app.use(cors())
app.polling = false;

/* 
  Signup Page for new Users 
*/

app.post('/signup', jsonParser, async function(req,res){
  res.setHeader('Content-Type', 'application/json')  
  let success = await rfC.signup(req.body.email);
  if (success === true) {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      state: state.ok, 
      message: "Thanks for signing up. Check your mailbox."
    }));   
  }
  else {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      state: state.error, 
      message: success
    }));    
  }
});

/* 
  Delete Issue: either leave an issue if shared or delete complete
*/

app.post('/delete', jsonParser, async function(req,res){
  res.setHeader('Content-Type', 'application/json')  
  let success = await rfC.leaveIssue(req.body.credentials.user, req.body.credentials.key, req.body.data.issue);
  if (success === true) {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      state: state.ok, 
      message: "Successfully left the book."
    }));   
  }
  else {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      state: state.error, 
      message: success
    }));    
  }
});

/* 
  Add new issue for an user
*/

app.post('/add', jsonParser, async function(req,res){
  res.setHeader('Content-Type', 'application/json')  
  let success = await rfC.addIssue(req.body.credentials.user, req.body.credentials.key);
  if (success === true) {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      state: state.ok, 
      message: "Book added."
    }));   
  }
  else {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      state: state.error, 
      message: success
    }));    
  }
});

/* 
  Share Issue: Add User to the allowed users
*/

app.post('/share', jsonParser, async function(req,res){
  res.setHeader('Content-Type', 'application/json')  
  let success = await rfC.inviteIssue(req.body.credentials.user, req.body.credentials.key, req.body.data.issue, req.body.data.invite);
    if (success === true) {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      state: state.ok, 
      message: "User invited."
    }));   
  }
  else {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      state: state.error, 
      message: success
    }));    
  }
});

/* Exporters: Returns a list of exporters available  */

app.post('/exporters', jsonParser, async function(req,res){
  res.setHeader('Content-Type', 'application/json')  
  let success = await rfC.getExporters(req.body.credentials.user, req.body.credentials.key);
  if (success === false) {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      state: state.error, 
      message: "Wrong Credentials"
    }));    
  }
  else {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      exporters: success,
      state: state.ok,
    }));   
  }
});

/* Exporters: Returns a list of exporters available  */

app.post('/export', jsonParser, async function(req,res){
  res.setHeader('Content-Type', 'application/json')  
  let success = await rfC.doExport(req.body.credentials.user, req.body.credentials.key, parseInt(req.body.data.exporterId), parseInt(req.body.data.issueId));
  if (success === false) {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      state: state.error, 
      message: "Wrong Credentials"
    }));    
  }
  else {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      exporters: success,
      state: state.ok
    }));   
  }
});

/* 
 * Callback: 
 * Passed as argument to the rokfor generator in the POST /exporter router
 * and called back after generator process has finished. E
 *
 * { status: 'Complete',
 * id: INTEGER (jobid),
 * data:
 *  { Id: INTEGER (jobid),
 *    File: { 
 *      file1: 'https://url.com/file.pdf',
 *      file2: 'https://url.com/file2.pdf' 
 *    },
 *    Date: INTEGER (Unix Timestamp),
 *    Issue: INTEGER (issue id),
 *    Plugin: INTEGER (plugin id),
 *    Pages: { 
 *      file1: [Object], 
 *      file2: [Object] 
 *    },
 *    Otc: STRING (session auth, jwt),
 *    ConfigSys: STRING (i.e. 'issues'),
 *    ConfigValue: INTEGER (status, 2 equals 'Complete'),
 *    Sort: null } }
 */

app.post('/callback/:uid', jsonParser, async function(req,res){
  res.setHeader('Content-Type', 'application/json');
  if (rfC.checkValidCallback(req.params.uid) === true) {

    /* TODO: Add Info into CouchDB here in rf-issue, under "exports" */
   
    let _status = await rfC.storeExport(req.body.status, req.body.data.Issue, req.body.data);  

    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      message: _status,
      state: _status == 'ok' ? state.ok : state.error
    })); 
  }
  else {
    res.send(JSON.stringify({
      application: appname, 
      version: version, 
      message: "generator returned an error",
      state: state.error, 
    })); 
  }
});

/* Polling:
   Synchronises the issue database in rokfor with couchdb
   Adds users and issues
*/

app.post('/poll', jsonParser, function (req, res) {
  if (app.polling === true) {
    log.info("--------------- polling in progress -----------------")
    res.send("polling in progress...");
  }
  else {
    log.info("--------------- polling -----------------")
    app.polling = true;
    rfC.loadUsers().then(function(users) {
      // Check if DBs exist in CouchDB: issue-{issueid} and rf-{username}
      // Check if user exists in CouchDB
      if (users) {
        rfC.checkDatabase(users).then(function() {
          rfC.reWatch();
          app.polling = false;
          res.send("ok");
        });
      }
      else {
        app.polling = false;
        res.send("could not connect to server");
      }
    })
  }
});

/* Syncing:
   Syncs changes from Rokfor to CouchDB
   IMPLEMENTATION NEEDED!
*/

app.get('/sync/:rfId(\d+)', jsonParser, function (req, res) {
  res.send("ok");
  req.params.rfId
  rfC.syncContribution(req.params.rfId);
});


/* Start Page:
   Nothing to show
*/

app.get('/',function(req,res)
{
  res.setHeader('Content-Type', 'application/json')
  res.send(JSON.stringify({application: "Rokfor Writer Server", version: version})); 
});


rfC.initialize().then(function(data){
  if (data !== false) {
    rfC.writer2rokfor();
  }
  var config = require('./config/config.js')
  var port = (process.env.PORT || config.pollport);
  app.listen(port, function () {
    log.info("* starting Rokfor -> Writer Sync...")
    log.info(`  - Listening on Port ${port}`)
  });
});
