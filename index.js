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
    this.locks = {};
    this.issues = {};
    this.changeStack = [];
    this.changesWorking = false;
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
        log.error(`Load Users Failed: ${res.error}`);
        deferred.resolve(false);
      }
      else {
        deferred.resolve(res.body);
      }
    });
    return deferred.promise;
  }

  /**
   *  checkDatabase
   *  - checks CouchDB for existing users and databases.
   **/

  checkDatabase(users, uindex, deferred) {
    deferred = deferred || q.defer();
    uindex = uindex || 0;
    if (users[uindex] === undefined) {
      deferred.resolve(true);
      return;
    }
    let username = users[uindex].Name;
    let apikey = users[uindex].Key;

    var _this = this;
    var db = this.connection.database(`rf-${username}`);

    log.info(`*** checkDatabase: ${username}`)

    db.exists(function (err, exists) {
      if (!err) {
        if (!exists) {
          log.info(`    + IssueDB Creating rf-${username}`);
          db.createWithUser(
              username,      // username
              apikey,        // password
              ["admin"],            // array of roles
              function (err, res) {       // callback
                if (!err) {
                  db.addNames(
                      [ username ],               // array of admin roles
                      [ username ],               // array of member roles
                      function (err, res) {       // callback
                        _this.syncIssues(username, apikey).then(function(){
                          _this.checkDatabase(users, ++uindex, deferred)
                        })
                      }
                  );
                }
              }
          );
        }
        else {
          log.info(`    - IssueDB Exists: rf-${username}`);
          _this.syncIssues(username, apikey).then(function(){
            _this.checkDatabase(users, ++uindex, deferred)
          });
        }
      }
    });
    return deferred.promise;
  }

  /* Checks for existence of issue-{id} Databases in CouchDB
   * - If it doesn't exists, adds it with the correct user
   * - If it exists, checks the user rights
   */

  syncIssueBase(issues, username, apikey, issue_index, deferred) {
    deferred = deferred || q.defer();
    var _this = this;
    var issue_index = issue_index || 0;

    if (issues[issue_index] === undefined) {
      deferred.resolve(true);
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
              ["admin"],               // array of roles
              function (err, res) {       // callback
                if (!err) {
                  db2.addNames(
                      [ username ],               // array of admin roles
                      [ username ],               // array of member roles
                      function (err, res) {       // callback
                        // log.info(res);
                        //_this.syncIssues(username, apikey)
                        _this.syncIssueBase(issues, username, apikey, ++issue_index, deferred)
                      }
                  );
                }
                else {
                  log.info(`syncIssueBase: Error occurred while creating issue-${issueId}`);
                  deferred.resolve(false);
                }
              }
          );
        }
        else {
          log.info(`Checking rights for issue-${issueId} / user ${username}`);
          db2.get('_security', function (err, doc) {
            if (!err) {
              let _existing = doc.admins ? doc.admins.names : [];
              if (_existing.indexOf(username) === -1) {
                _existing.push(username);
                db2.addNames(
                    _existing,               // array of admin roles
                    _existing,               // array of member roles
                    function (err, res) {       // callback
                        //log.info(res);       // it should be { ok: true } if no error occurred
                        _this.syncIssueBase(issues, username, apikey, ++issue_index, deferred)
                    }
                );
              }
              else {
                _this.syncIssueBase(issues, username, apikey, ++issue_index, deferred)
              }
            }
            else {
              log.info(`syncIssueBase: Error occurred while checking _security of issue-${issueId}`);
              deferred.resolve(false);
            }
          });
        }
      }
    });
    return deferred.promise;
  }



  /**
   *  syncIssues
   *  - syncs Issues from CouchDB with Rokfor.
   **/

  syncIssues(username, apikey) {
    /* TODO Download Issues and store them here... */
    /* Sync even if db exist. */
    var deferred = q.defer();
    var _this = this;
    var req = this.unirest("GET", `${this.api.endpoint}issues`);
    req.headers({
      "cache-control": "no-cache",
      "authorization": `Bearer ${apikey}`
    });
    req.end(function (res) {
      if (res.error) {
        log.error('syncIssues: could not connect to rokfor api');
        deferred.resolve(false);
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
                  _this.syncIssueBase(res.body.Issues, username, apikey).then(function() {
                    deferred.resolve(true);
                  })
                }
                else {
                  deferred.resolve(false);
                }
              });
            }
            else {
              log.info('error merging Issues into CouchDB');
              deferred.resolve(false);
            }
          }
          else {
            log.info(`synced issues for ${username}`)
            if (res.body && res.body.Issues) {
              _this.syncIssueBase(res.body.Issues, username, apikey).then(function(){
                deferred.resolve(true);
              })
            }
            else {
              log.info(`no issues for ${res.body}`)
              deferred.resolve(false);
            }
          }
        });
      }
    });
    return deferred.promise;
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
        log.error(`Login Failed: ${res.error}`);
        deferred.resolve(false);
      }
      else {
        _this.jwt = res.body;
        deferred.resolve(_this.jwt);
      }
    });
    return deferred.promise;
  }

  /**
   * reWatch
   * Stops all watchers
   * Restarts writer2rokfor
   **/
  reWatch() {


      this.watchers.forEach(function(watcher){
        watcher.stop();
      })
      this.watchers = [];

      log.info(`reWatch: stopped all watchers. counting: ${this.watchers.length} after...`)

      this.writer2rokfor();
  }

  async changesStackPush(name, c) {
    c = c || false;
    let _this = this;
    
    // Add Changes to Stack if there is a change parameter

    if (c !== false) {
      this.changeStack.push(c);  
      log.info(`INCOMING CHANGE: ${c.deleted ? 'DELETE' : 'UPDATE'} ${c.doc.data.id} Stack length is now ${this.changeStack.length}`);
      // Stop here if working changes are in progress
      if (this.changesWorking === true) {
        return;
      }
    }


    // Get Current Changes Object: First from stack
    
    let changes = this.changeStack.length > 0 ? this.changeStack[0] : false;

    // Return if there is nothing to do, reactivate state

    if (changes === false) {
      this.changesWorking = false;
      return;
    }

    // Start Propagating Changes to Rokfor - Lock Process.

    this.changesWorking = true;


    // Create, Update, Delete
    if (changes.deleted === true) {
      log.info("DELETE Document", changes.doc.data);

      // Await DELETE DOCUMENT
      try {
        await new Promise((resolve, reject) => {
          var req = _this.unirest("DELETE", `${_this.api.endpoint}contribution/${changes.doc.data}`);
          req.headers({
            "content-type": "application/json",
            "authorization": `Bearer ${_this.jwt}`
          });
          req.end(function (res) {
            if (res.error) {
              reject(res.error);
            } else {
              resolve(true);
            }
          });
        });
        log.info("DELETE Document ok");
      } catch (err) {
        log.info(`DELETE Document failed ${err}`);
      }
    }

    else {
      if (changes.doc.data !== undefined) {
        if (changes.id.indexOf('options') !== -1) {
          if (changes.doc.data.Id) {
            log.info(`UPDATE Issue from DB ${changes.doc.data.Id}`);
            let issue = changes.doc.data;
            
            // Await POST ISSUE

            try {
              await new Promise((resolve, reject) => {
                var req = this.unirest("POST", `${this.api.endpoint}issue/${issue.Id}`);
                req.headers({
                  "authorization": `Bearer ${this.jwt}`,
                  "Content-Type": "application/json"
                })
                .type("json")
                .send({
                  "Name": issue.Name,
                  "Options": issue.Options
                })
                .end(function (res) {
                  if (res.error) {
                    reject(res.error)
                  }
                  else {
                    resolve(res.body);
                  }
                });
              });
              log.info('POST Issue ok');
            } catch (err) {
              log.info(`POST Issue failed ${err}`);
            }
            
          }
        }
        else {

          try {
            await new Promise((resolve, reject) => {
              _this.storeContribution(changes, name).then(function(){
                resolve(true);
              }).catch(function(err){
                //if (_this.isLockedContribution(changes.id)) {
                //  reject('CONTRIB LOCKED');
                //}
                log.info(`PUT Document ${_this.api.endpoint}contribution`);
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
                     reject("PUT FAILED");
                  }
                  else {

                    let _newContribution = res.body;
                    // This couchDB-id will be locked from now on, since it's put into rokfor.

                    _this.locks[changes.id] = _newContribution.Id;

                    _this.storeContribution(changes, name, _newContribution.Id).then(function(){
                      _this.updateCouch(changes, name, _newContribution.Id).then(function(){
                        resolve(true);
                      });
                    }).catch(function(err){
                        reject("POST FAILED");
                    });
                  }
                });

              });
            })
            log.info('POST Contribution OK')
          } catch (err) {
            log.info(`POST Contribution failed ${err}`);
          }
        }
      }
    }

    this.changeStack.splice(0, 1);
    this.changesStackPush(name);

  }


  /**
   * writer2rokfor
   * Direction: Writer -> Rokfor
   * Listen to changes within issue-* Databases
   * Listen to CouchDB watch stream
   **/

  async writer2rokfor() {
    log.info("* starting Writer -> Rokfor Sync...")
    let _this = this;
    this.connection.databases(function(a,e){
      e.forEach(function(name) {

        /* Watching ISSUES Databases */

        if (name.indexOf("issue-") !== -1) {
          let _watcher = _this.connection.database(name).changes({since:"now", include_docs: true});
          _watcher.on('change', function (changes) {
            _this.changesStackPush(name, changes);
          }.bind(name));
          _watcher.on('error', function(err){
            log.info("Error Ocurred", err);
          })
          _watcher.on('stop', function(){
            log.info(`Stopping Watcher for db: ${this.db.split('/').splice(-1)}`);
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

    if (this.locks[changes.id]) {
      log.info("Apply Lock")
      id = this.locks[changes.id];
    }


    let _this = this;
    
    var req = _this.unirest("POST", `${_this.api.endpoint}contribution/${id}`);
    req.headers({
      "authorization": `Bearer ${_this.jwt}`,
      "Content-Type": "application/json"
    });
    req.type("json");
    let payload = {
      "Sort": changes.doc.data.sort,
      "Status": "Draft",
      "Data": {
        "Title": changes.doc.data.title,
        "Body": changes.doc.data.body,
        "_couchDB": changes.id,
        "_couchVersion": changes.doc._rev.split('-')[0]
      }
    };
    // Adding Name only if set - otherwise Rokfor sends an error...
    if (changes.doc.data.name) {
      payload.Name = changes.doc.data.name;
    }
    req.send(payload);
    req.end(function (res) {
      if (res.error || !res.body.Id) {
        deferred.reject(false);
      }
      else {
        deferred.resolve(res.body.Id);
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
app.polling = false;

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
