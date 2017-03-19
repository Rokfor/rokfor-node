/**
 *  Rokfor Node Connector
 *  ---------------------
 *
 *  Propagates Rokfor Database Changes to a CouchDB
 *
 **/
"use strict";

var config = require('./config/config.js')

var q = require("q"),
    express = require('express'),
    bodyParser = require('body-parser'),
    fs = require('fs'),
    Log = require('log'),
    log = new Log(config.loglevel, fs.createWriteStream('my.log'));


class RokforConnector {
  constructor() {


    var
      server      = config.server,
      port        = config.port,
    	username    = config.username,
      userpass    = config.userpass;
    this.cradle      = require('cradle_security')({
                        debug: false,                // set true to see all log messages
                        adminUsername: username,     // set your admin username
                        adminPassword: userpass   // set your admin password
                    });
    // setup the database
    this.cradle.setup({
        host: server,          // CouchDB host (default localhost only)
        port: port,                 // CouchDB port
        cache: false,                // CouchDB cache
        timeout: 5000               // connection timeout
    });
    this.connection  = new(this.cradle.Connection)(server, port, {auth: { username: username, password: userpass }}),
    this.watchers = [];
    this.unirest  = require("unirest");
    this.jwt = false;
    this.api = config.api;
    this.locks = [];
  }

  /**
   *  initialize
   *  - calls r/w function every 10 minutes
   **/

  initialize() {
    var deferred = q.defer();
    setInterval(this.createJWT.bind(this), 10*60*1000);
    this.createJWT().then(function(data) {
      deferred.resolve(data);
    });
    return deferred.promise;
  }

  /**
   *  loadUsers
   *  - loads users from rokfor backend
   **/

  loadUsers() {
    var deferred = q.defer();
    var req = this.unirest("GET", `${this.api.endpoint}users`);
    req.headers({
      "content-type": "application/json",
      "authorization": `Bearer ${this.api.rokey}`
    });
    req.end(function (res) {
      if (res.error) {
        throw new Error(res.error);
        deferred.resolve(false);
      }
      deferred.resolve(res.body);
    });
    return deferred.promise;
  }

  /**
   *  checkDatabase
   *  - checks CouchDB for existing users and databases.
   **/

  checkDatabase(username, apikey) {
    var _this = this;
    var db = this.connection.database(`rf-${username}`);
    db.exists(function (err, exists) {
      if (!err) {
        if (!exists) {
          log.info(`Creating rf-${username}`);
          db.createWithUser(
              username,      // username
              apikey,        // password
              ["admins"],            // array of roles
              function (err, res) {       // callback
                if (!err) {
                  db.addNames(
                      [ username ],               // array of admin roles
                      [ username ],               // array of member roles
                      function (err, res) {       // callback
                        log.info(res);
                        _this.syncIssues(username, apikey)
                      }
                  );
                }
              }
          );
        }
        else {
          _this.syncIssues(username, apikey)
        }
      }
    });
  }

  /* Checks for existence of issue-{id} Databases in CouchDB
   * - If it doesn't exists, adds it with the correct user
   * - If it exists, checks the user rights
   */

  syncIssueBase(issues, username, apikey, issue_index) {
    var _this = this;
    var issue_index = issue_index || 0;

    if (issues[issue_index] === undefined) {
      return;
    }

    let issueId = issues[issue_index].Id


    var db2 = this.connection.database(`issue-${issueId}`);
    db2.exists(function (err, exists) {
      if (!err) {
        if (!exists) {
          log.info(`Creating issue-${issueId}`);
          db2.createWithUser(
              username,                 // username
              apikey,        // password
              ["admins"],               // array of roles
              function (err, res) {       // callback
                if (!err) {
                  db2.addNames(
                      [ username ],               // array of admin roles
                      [ username ],               // array of member roles
                      function (err, res) {       // callback
                        log.info(res);
                        _this.syncIssues(username, apikey)
                        _this.syncIssueBase(issues, username, apikey, ++issue_index)
                      }
                  );
                }
              }
          );
        }
        else {
          log.info(`Checking rights for issue-${issueId} / user ${username}`);
          db2.get('_security', function (err, doc) {
            let _existing = doc.admins.names;
            if (_existing.indexOf(username) === -1) {
              _existing.push(username);
              db2.addNames(
                  _existing,               // array of admin roles
                  _existing,               // array of member roles
                  function (err, res) {       // callback
                      log.info(res);       // it should be { ok: true } if no error occurred
                      _this.syncIssueBase(issues, username, apikey, ++issue_index)
                  }
              );
            }
          });
        }
      }
    });
  }



  /**
   *  syncIssues
   *  - syncs Issues from CouchDB with Rokfor.
   **/

  syncIssues(username, apikey) {
    /* TODO Download Issues and store them here... */
    /* Sync even if db exist. */
    var _this = this;
    var req = this.unirest("GET", `${this.api.endpoint}issues`);
    req.headers({
      "cache-control": "no-cache",
      "authorization": `Bearer ${apikey}`
    });
    req.end(function (res) {
      if (res.error) {
        log.info('syncIssues: could not connect to rokfor api');
      }
      else {
        let _db = _this.connection.database(`rf-${username}`);
        _db.merge('issues', {data: res.body}, function (err, _res) {
          if (err) {
            if (err.reason === 'missing') {
              _db.save('issues', {
                data: res.body
              }, function (err, res) {
                log.info(`created issues for ${username}`)
                if (res.body && res.body.Issues) {
                  _this.syncIssueBase(res.body.Issues, username, apikey)
                }
                _this.reSync();
              });
            }
            else {
              log.info('error merging Issues into CouchDB')
            }
          }
          else {
            log.info(`synced issues for ${username}`)
            if (res.body && res.body.Issues) {
              _this.syncIssueBase(res.body.Issues, username, apikey)
            }
            else {
              log.info(`no issues for ${res.body}`)
            }
            _this.reSync();
          }
        });
      }
    });



  }

  /**
   *  createJWT
   *  - login as r/w user at the rokfor backend
   **/

  createJWT() {
    var deferred = q.defer();
    var req = this.unirest("POST", `${this.api.endpoint}login`);
    var _this = this;
    req.headers({
      "content-type": "application/x-www-form-urlencoded"
    });
    req.form({
      "username": this.api.user,
      "apikey": this.api.rwkey
    });
    req.end(function (res) {
      if (res.error) {
        throw new Error(res.error);
        deferred.resolve(false);
      }
      _this.jwt = res.body;
      deferred.resolve(_this.jwt);
    });
    return deferred.promise;
  }

  /**
   * reSync
   * Stops all watchers
   * Restarts writer2rokfor
   **/
  reSync() {
      /*this.watchers.forEach(function(watcher){
        watcher.stop();
      })*/
      this.writer2rokfor();
  }

  isLockedContribution(id) {
    let i = this.locks.indexOf(id) > -1 ? true : false;
    if (i === true) {
      log.info(`IS Locked ${id}`);
    }
    return (i);
  }

  lockContribution(id) {
    //console.log(`Add lock ${id}`);
    this.locks.push(id);
  }

  unlockContribution(id) {
    let i = this.locks.indexOf(id);
    if (i > -1) {
      //console.log(`Unlock ${id}`);
      this.locks.splice(i, 1);
    }
  }


  /**
   * writer2rokfor
   * Direction: Writer -> Rokfor
   * Listen to changes within issue-* Databases
   * Listen to CouchDB watch stream
   **/

  writer2rokfor() {
    log.info("* starting Writer -> Rokfor Sync...")
    let _this = this;
    this.connection.databases(function(a,e){
      e.forEach(function(name) {
        if (name.indexOf("issue-") !== -1) {
          let _watcher = _this.connection.database(name).changes({since:"now", include_docs: true});
          _watcher.on('change', function (changes) {

            if (_this.isLockedContribution(changes.id) === true) {
              return;
            }


            // Create, Update, Delete
            if (changes.deleted === true) {
              //console.log(`DEL Document Id ${changes.id}`, changes.doc.data);
              log.info("DELETE Document");

              _this.lockContribution(changes.id);
              var req = _this.unirest("DELETE", `${_this.api.endpoint}contribution/${changes.doc.data}`);
              req.headers({
                "content-type": "application/json",
                "authorization": `Bearer ${_this.jwt}`
              });
              req.end(function (res) {
                if (res.error) {
                  //console.log(res.error);
                }
                //console.log(res.body);
              });
            }
            else {
              if (changes.doc.data !== undefined) {
                if (changes.doc.data.id === -1 || changes.doc.data.id === 0) {
                  _this.lockContribution(changes.id);
                  log.info("PUT Document");
                  // Creat new Rokfor Document
                  var req = _this.unirest("PUT", `${_this.api.endpoint}contribution`);
                  req.headers({
                    "content-type": "application/json",
                    "authorization": `Bearer ${_this.jwt}`
                  });
                  req.type("json");
                  req.send({
                    "Template": _this.api.template,
                    "Name": changes.doc.data.name,
                    "Chapter": _this.api.chapter,
                    "Issue": parseInt(changes.doc.data.issue),
                    "Status": "Draft"
                  });
                  req.end(function (res) {
                    if (res.error) {
                       log.info(res.error);
                    }
                    else {
                      let _newContribution = res.body;
                      _this.storeContribution(changes, name, _newContribution.Id).then(function(err){
                        log.info('+++ finished storeContribtution: ', err);
                        if (err) {
                          _this.unlockContribution(changes.id);
                        }
                        else {
                          // Update CouchDB with Rokfor id
                          _this.updateCouch(changes, name, _newContribution.Id).then(function(err){
                            _this.unlockContribution(changes.id);
                          });
                        }
                      });

                    }
                  });
                }
                else {
                  _this.lockContribution(changes.id);
                  // console.log(`UPDATE Document ${changes.doc.data.name}`);
                  _this.storeContribution(changes, name).then(function(err){
                    _this.unlockContribution(changes.id);
                  });
                }

              }
            }
          }.bind(name));
          _watcher.on('error', function(err){
            log.info("Error Ocurred", err);
          })
          _this.watchers.push(_watcher);
        }
      })
    });
  }

  /**
   * updateCouch
   * updates a CouchDB Document with a new RokforId, called
   * after creating a new rokfor contribution.
   **/

  updateCouch(changes, dbname, id) {
    var deferred = q.defer();
    log.info('need to update id in CouchDB', changes.doc.data.id, id);
    if (changes.doc.data.id !== id) {
      let _db = this.connection.database(dbname);
      let _data = changes.doc.data;
      _data.id = id;
      _db.merge(changes.id, {rokforid: id, data: _data}, function (err, res) {
        //console.log(err, res);
        deferred.resolve(true);
      });
    }
    return deferred.promise;
  }

  /**
   * storeContribution
   * storing changes in a rokfor Document after CouchDB has changed
   **/

  storeContribution(changes, dbname, id) {

    /*

    TODO: if document is not existing in rokfordatabase and the id is not -1, still put it and reset the id.

    */

    var deferred = q.defer();
    id = id || changes.doc.data.id;
    log.info('storeContribution', id);
    let _this = this;
    var req = _this.unirest("POST", `${_this.api.endpoint}contribution/${id}`);
    req.headers({
      "authorization": `Bearer ${_this.jwt}`,
      "Content-Type": "application/json"
    });
    req.type("json");
    req.send({
      "Name": changes.doc.data.name,
      "Sort": changes.doc.data.sort,
      "Status": "Draft",
      "Data": {
        "Title": changes.doc.data.title,
        "Body": changes.doc.data.body,
        "_couchDB": changes.id,
        "_couchVersion": changes.doc._rev.split('-')[0]
      }
    });
    req.end(function (res) {
      if (res.error) {
        log.info("Error while posting: ", res);
        let _db = _this.connection.database(dbname);
        let _data = changes.doc.data;
        _data.id = -1;
        _db.merge(changes.id, {rokforid: -1, data: _data}, function (err, res) {
          if (err) {
            log.info("Error while resetting to -1 in CouchDB", err, res);
          }
          else {
            log.info("Resetting to -1 in CouchDB");
          }
          deferred.resolve(true);
        });
      }
      else {
        deferred.resolve(false);
      }
    });
    return deferred.promise;
  }

  /*
   * Syncing Changes Back from Rokfor.
   *
   */

  syncContribution(rokforId) {

      // IMPLEMENTATION NEEDED !

  }

}

var rfC = new RokforConnector();
var app = express();
var jsonParser = bodyParser.json()

app.post('/poll', jsonParser, function (req, res) {
  res.send("ok");
  rfC.loadUsers().then(function(users) {
    log.info(users);
    // Check if DBs exist in CouchDB: issue-{issueid} and rf-{username}
    // Check if user exists in CouchDB
    users.forEach(function(u){
      rfC.checkDatabase(u.Name, u.Key);
    })
  })
});

app.get('/sync/:rfId(\d+)', jsonParser, function (req, res) {
  res.send("ok");
  req.params.rfId
  rfC.syncContribution(req.params.rfId);
});

app.get('/',function(req,res)
{
    res.send("Rokfor <-> CouchDB Sync Server");
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
