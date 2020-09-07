module.exports =  function(config, log, slack) {

	/* Globals */

    var
	  	domain      = config.domain,
      server      = config.server,
      port        = config.port,
      username    = config.username,
			userpass    = config.userpass,
			storefile   = config.storefile,
			disablesignup = config.disablesignup,
      nodemailer  = require('nodemailer'),
      q           = require("q"),
      request     = require('request');

  	/* Setup Class Var */

  	var module = {
  		validcb:    [],
	    watchers: 	[],
	    unirest: 	require("unirest"),
	    jwt: 		false,
	    api: 		config.api,
	    locks: 		{},
	    issues: 	{},
	    changeStack: [],
	    changesWorking: false,
	    smtp: 		config.mailer
	};

	/* Cradle and CouchDB Setup */

	module.cradle = require('cradle_security')({
		debug: false,                // set true to see all log messages
		adminUsername: username,     // set your admin username
		adminPassword: userpass   // set your admin password
	});

    module.cradle.setup({
        host: server,          // CouchDB host (default localhost only)
        port: port,                 // CouchDB port
        cache: false,                // CouchDB cache
        timeout: 5000               // connection timeout
    });

    module.connection = new(module.cradle.Connection)(server, port, {
    	auth: { 
    		username: username, 
    		password: userpass 
    	}
    });


	  /**
	   *  initialize
	   *  - calls r/w function every 10 minutes
	   **/

	  module.initialize = function() {
	    var deferred = q.defer();
	    setInterval(module.createJWT.bind(module), 10*60*1000);
	    module.createJWT().then(function(data) {
	      deferred.resolve(data);
	    });
	    return deferred.promise;
	  }

	  module.guidGenerator = function() {
	    var S4 = function() {
	       return (((1+Math.random())*0x10000)|0).toString(16).substring(1).toLowerCase();
	    };
	    return (Date.now() + "-"+S4()+S4()+S4());
	  }


	  module.putIssueRokfor = function(group) {
	    let self = module;
	    return new Promise((resolve, reject) => {
	      var req = self.unirest("PUT", `${self.api.endpoint}issue`);
	      req.headers({
	        "content-type": "application/json",
	        "authorization": `Bearer ${self.jwt}`
	      });
	      req.type("json");
	      req.send({
	        "Name": "Your First Book",
	        "Forbook": self.api[group].book
	      });
	      req.end(function (res) {
	        if (res.error) {
	           reject("PUT FAILED");
	        }
	        else {
	          let _newIssue = res.body.Id;
	          var _req = self.unirest("GET", `${self.api.endpoint}issues/${_newIssue}`);
	          _req.headers({
	            "content-type": "application/json",
	            "authorization": `Bearer ${self.api.rokey}`
	          });
	          _req.end(function (res) {
	            if (res.error) {
	              log.info(res);
	              log.error("Load Issue Failed");
	              reject("Load Issue Failed");
	            }
	            else {
	              resolve(res.body);
	            }
	          });
	        }
	      });
	    });
	  }

	  /* 
	  	Check if users exists. Return err if promise is rejected 
	  	@param email 	string
	  	@param b64mail 	string
	  	@return bool true on success, string on failure
	  */

	  module.checkExistingEmail = async function (email, b64mail) {
			if (/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/.test(email)) {
					try {
						let r = await new Promise((resolve, reject) => {
							var db = module.connection.database(`email`);
							db.get(email, function (err, doc) {
								if (err && err.error === "not_found") {
									db.save(email, {
										key: b64mail,
										state: "unused"
									}, function (err, res) {
										if (err) {
											reject("E-Mail could not be stored.");
										}
										else {
											resolve(true);
										}
									});
								}
								else {
									reject("E-Mail already registered.");
								}
								
							});
						});
						return r;
					} catch (err) {
						return err;
					}	  	
			} else {
				return "Not a valid e-mail address.";
			}
	  }

	  /* 
	  	check if a user database for a user and password exist 
	  	@param b64mail	string
	  	@param password string
	  	@return database if credentials are correct, false on error
	  */

	  module.loadUserDatabase = async function(b64mail, password) {
		try {
		  let r = await new Promise((resolve, reject) => {
		    let connection = new(module.cradle.Connection)(server, port, {
		    	auth: { 
		    		username: b64mail, 
		    		password: password 
		    	}
		    });
			let db = connection.database(`rf-${b64mail}`);
		    db.get("issues", function (err, doc) {
				if (err) {
					reject(false);
				}
				else {
					resolve(db);
				}		      
		    });
		  });
		  return r;
		} catch (err) {
		  return false;
		}	  	
	  }


	  /* 
	  	check if a issues database for a user and password exist 
	  	@param b64mail	string
	  	@param password string
	  	@return database if credentials are correct, false on error
	  */

	  module.loadIssueDatabase = async function(b64mail, password, issue) {
		try {
		  let r = await new Promise((resolve, reject) => {
		    let connection = new(module.cradle.Connection)(server, port, {
		    	auth: { 
		    		username: b64mail, 
		    		password: password 
		    	}
		    });
			let db = connection.database(`issue-${issue}`);
		    db.exists(function (err, exists) {
		    	if (err || exists === false) {
      				reject(false);
    			} else {
					resolve(db);
				}		      
		    });
		  });
		  return r;
		} catch (err) {
		  return false;
		}	  	
	  }


	  module.signup = async function(email, group) {

	    let b64mail = module.guidGenerator();
	    let check = await module.checkExistingEmail(email, b64mail);
		
		if (disablesignup === true) {
			return "Signup disabled. Contact sysop to enable it.";
		}

		if (!group || module.api[group] == undefined) {
			return "Group not existing. Contact sysop for available groups.";
		}

	    if (check !== true) {
	    	return check;
	    }



	    /* Continue here: User does not exist */

	    try {
	      let r = await new Promise((resolve, reject) => {
	        var db = module.connection.database(`rf-${b64mail}`);
	        let self = module;
	        log.info(`*** checkDatabase: ${b64mail}`)
	        db.exists(async function (err, exists) {
	          if (!err && !exists) {
	            console.log(`DB DOES NOT EXIST: rf-${b64mail}`)

	            // Create new password
	            let password = Math.random().toString(36).slice(-8);
	            let subject = 'Writer Signup';
	            let message = '<b>You just signed up for rokfor writer:</b><br>This is your password: ' + password + '<br>This is your access key: ' + b64mail;
	            let res = await self.sendMail(email, password, subject, message);
	            if (res === true) {
	              slack.notify(`User ${email} signed up`);
	              console.log(`Mail sent to ${email}`)
	              let add = await self.addDatabase(db, b64mail, password);
	              if (add === true) {
	                console.log(`Database added`)

	                // Put a rokfor issue here for starters
	                let newIssue = false;
	                try {
	                  newIssue = await self.putIssueRokfor(group);
	                } catch (err) {
	                  reject ("Could not add new issue");
	                }

	                // Add the issue database to couch with the right user
	                let newIssueId = false;
	                try {
	                  newIssueId = newIssue.Issues[0].Id;
	                } catch (err) {
	                  reject("New Issue returned no id");
	                }

	                let newissue = self.connection.database(`issue-${newIssueId}`);
	                await self.addDatabase(newissue, b64mail, password, {
	                	key: `contribution-${newIssueId}-options`,
	                	data: newIssue.Issues[0]
	                });

	                // Update rf-{username} with the newly issue id

	                db.save('issues', {
	                  data: newIssue
	                }, function (err, res) {
	                  if (err) {
	                    reject ("Could not add new issue");
	                  }
	                  else {
	                    self.reWatch();
	                    resolve(true);
	                  }
	                });


	                
	              }
	              else {
	                reject (add);
	              }
	            }
	            else {
	            	log.info(res);
	              reject (res);
	            }
	          }
	          else {
	            reject('User already exists');
	          }
	        });
	      });
	      return r;
	    } catch (err) {
	      return err;
	    }
	  }


	  /* 
	  	Generic function to add a database with a certain user/key to CouchDB 
	  	@param db  		cradle  object
	  	@param username string
	  	@param apikey 	string
	  */


	  module.addDatabase = async function(db, username, apikey, initialdata) {
	  	initialdata = initialdata || false;
	    try {    
	      let r = await new Promise((resolve, reject) => {
	        db.createWithUser(
	              username,      // username
	              apikey,        // password
	              ["admin"],            // array of roles
	              function (err, res) {       // callback
	                if (!err) {
	                  db.addNames(
	                      [ username ],               // array of admin roles
	                      [ username ],
	                      function (err, res) {       // callback
	                        if (!err) {
	                          console.log(res);
	                          resolve(true);
	                        } else {
	                          console.log(err);
	                          reject("Error adding database..");
	                        }
	                      }
	                  )
	                }
	                else {
	                  console.log(err)
	                  reject("Error adding database.")
	                }
	              }
	        )
	      });
	      if (initialdata) {
	      	try {
				let store = await new Promise((resolve, reject) => {
		      		db.save(initialdata.key, {
		                data: initialdata.data
		            }, function (err, res) {
		                if (err) {
		                  reject(false)
		                }
		                else {
		                  resolve(true)
		                }
		            });
		      	});
	      	} catch (err) {
	      		return err;	
	      	}
	      }
	      return r;
	    } catch (err) {
	      return err;
	    }
	  }

	  /* Mail Sender Function */

	  module.sendMail = async function(email, password, subject, message) {
	    try {    
	      let r = await new Promise((resolve, reject) => {
	        var transporter = nodemailer.createTransport(module.smtp);
	        var mailOptions = {
	            from: 		module.smtp.sender, // sender address
	            to: 		email, // list of receivers
	            subject: 	subject, // Subject line
	            html: 		message
	        };
	        transporter.sendMail(mailOptions, function(error, info){
	            if(error){
	              console.log(error);
	              reject("Error Sending E-Mail")
	            }else{
	              resolve(true);
	            };
	        });
	      });
	      return r;
	    } catch (err) {
	      return err;
	    }
	  }



	module.addIssue = async function(b64mail, password, group) {

		var userdb = await module.loadUserDatabase(b64mail, password);
		if (userdb === false) {
			return "Wrong Credentials";
		} else {
			// Add Issue to Rokfor Database
            let newIssue = false;
            try {
              newIssue = await module.putIssueRokfor(group);
            } catch (err) {
              return("Could not add new issue: " + err);
            }

            // Add the issue database to couch with the right user
            let newIssueId = false;
            try {
              newIssueId = newIssue.Issues[0].Id;
            } catch (err) {
              return("New Issue returned no id");
            }
            let newissue = module.connection.database(`issue-${newIssueId}`);
            try {
            	await module.addDatabase(newissue, b64mail, password,  {
	                key: `contribution-${newIssueId}-options`,
	            	data: newIssue.Issues[0]
	            });	
            }
            catch (err) {
            	return err;
            }
            
			// Load old issues into oldIssues

            let oldIssues = [];
            try	{
				oldIssues = await new Promise((resolve, reject) => {
	            	userdb.get("issues", function (err, doc) {
					if (err) {
						reject("Could not load issue database");
					}
					else {
						resolve(doc.data);
						}		      
				    });
	            });
            } catch (err) {
            	return err;
            }

            // Push new Issue infos onto the old stack
            log.info(oldIssues);
            try {
            	oldIssues.Issues.push(newIssue.Issues[0]);	
            } catch (err) {
            	return "could new onto old issue";
            }
            
            log.info(oldIssues);

            try	{
				let merged = await new Promise((resolve, reject) => {
					userdb.merge('issues', {data: oldIssues}, function (err, _res) {
						if (err) {
							reject ("Could not merge new issue into couch db");
						}
			            else {
			            	module.reWatch();
                			resolve(true);
			            }
			        });
				});
				// If we reached here, everything's okay and we need to return true
				return merged;

			} catch (err) {
				return err;
			}
		}
		return false;	
	}

   /**
    *  leaveIssue
    *  - remove Issue from rf-user Database
    *  - remove access from rf-issueId
    *  - if rf-issueId has no users left, delete the database
    **/


	module.leaveIssue = async function(b64mail, password, issueId) {
		var userdb = await module.loadIssueDatabase(b64mail, password, issueId);
		if (userdb !== false) {
			try {
				let deleted = await new Promise((resolve, reject) => {
					userdb.get('_security', function (err, doc) {

						// Leave Issue, no deletion
						// More than one users

						if (doc.admins.names.length > 1 || doc.readers.names.length > 1) {
							let _index = doc.admins.names.indexOf(b64mail);
							if (_index > -1) {doc.admins.names.splice(_index, 1);}
							let _index2 = doc.readers.names.indexOf(b64mail);
							if (_index2 > -1) {doc.readers.names.splice(_index2, 1);}
							userdb.addNames(
			                    doc.admins.names,               // array of admin roles
			                    doc.readers.names,               // array of member roles
			                    function (err, res) {       // callback
								    console.log(err, res);           // it should seem
							    	if (err) {
							    		reject("Could not remove User");
							    	}
							    	else {
							    		resolve(true);
							    	}
									}
							);
						}

						// Delete Issue
						// Only one user

						else {
							module.watchers.forEach(function(watcher){
								let _issue = watcher.db.split('/').splice(-1);
								let _id = _issue[0].split('-').splice(-1);
								log.info();
								if (_id[0] == issueId) {
									watcher.stop();		
								}
							});
							var deletedb = module.connection.database(`issue-${issueId}`);
							deletedb.destroy(function(err){
								if (err) {
									reject("Could not delete Database");
								}
								else {
									var req = module.unirest("DELETE", `${module.api.endpoint}issue/${issueId}`);
									req.headers({
										"authorization": `Bearer ${module.jwt}`,
										"Content-Type": "application/json"
									})
									.type("json")
									.send()
									.end(function (res) {
										if (res.error) {
											reject(res.error)
										}
										else {
											resolve(res.body);
										}
	                });
								}
							})
						}
					});
				});
			} catch (err) {
				return err; 
			}
		}

		// Remove Issue from rf-${user} database

		try {
			let issuedb = await module.loadUserDatabase(b64mail, password);
			let oldIssues = await new Promise((resolve, reject) => {
				issuedb.get("issues", function (err, doc) {
					if (err) {
						reject("Could not load issue database");
					}
					else {
						resolve(doc.data);
					}		      
				});
			});
			let _newIssues = [];
			oldIssues.Issues.forEach(function(_i){
				if (_i.Id != issueId) {
					_newIssues.push(_i);
				}
			});
			oldIssues.Issues = _newIssues;
			let merged = await new Promise((resolve, reject) => {
				issuedb.merge('issues', {data: oldIssues}, function (err, _res) {
					if (err) {
						reject ("Could not merge new issue into couch db");
					}
					else {
						module.reWatch();
						resolve(true);
					}
				});
			});
			return merged;
		} catch (err) {
			return(err);
		}
	}

	module.inviteIssue = async function(b64mail, password, issueId, invite) {
		var userdb = await module.loadUserDatabase(b64mail, password);
		if (userdb === false) {
			return "Wrong Credentials";
		} else {
			try {
				let _exists = await new Promise((resolve, reject) => {
					var checkdb = module.connection.database(`_users`);
					checkdb.get(`org.couchdb.user:${invite}`, function(err,res) {
						if (err && err.error === "not_found") {
							reject("User does not exist. Call him! Get his id...")
						}
						else {
							resolve(true);
						}
					});
				});
				if (_exists === true) {

					// Get Issue info from users issue database
					let oldIssues;
					try {
						oldIssues = await new Promise((resolve, reject) => {
			            	userdb.get("issues", function (err, doc) {
							if (err) {
								reject("Could not load issue database");
							}
							else {
								resolve(doc.data);
								}		      
						    });
			            });
					} catch (err) {
						return (err);
					}

					let _newIssue;
					oldIssues.Issues.forEach(function(_i){
		        		if (_i.Id == issueId) {
		        			_newIssue = _i;
		        		}
		      		});


					// Add issues to invitee's issue list

					let issuedb = module.connection.database(`rf-${invite}`);
					let inviteIssues;
		            try	{
						inviteIssues = await new Promise((resolve, reject) => {
			            	issuedb.get("issues", function (err, doc) {
							if (err) {
								reject("Could not load issue database");
							}
							else {
								resolve(doc.data);
								}		      
						    });
			            });
		            } catch (err) {
		            	return err;
		            }

		            // Push new Issue infos onto the old stack
		            try {
		            	inviteIssues.Issues.push(_newIssue);	
		            } catch (err) {
		            	return "Could not add new onto old issue";
		            }
		            

		            let merged = false
		            try	{
						merged = await new Promise((resolve, reject) => {
							issuedb.merge('issues', {data: inviteIssues}, function (err, _res) {
								if (err) {
									reject ("Could not merge new issue into couch db");
								}
					            else {
		                			resolve(true);
					            }
					        });
						});
					} catch (err) {
						return err;
					}


					if (merged === true) {
						try {
							// If we reached here, everything's okay and we need to return true
							let db2 = module.connection.database(`issue-${issueId}`);
							let added = await new Promise((resolve, reject) => {
								db2.get('_security', function (err, doc) {
									doc.admins.names.push(invite);
									doc.readers.names.push(invite);
									db2.addNames(
					                    doc.admins.names,               // array of admin roles
					                    doc.readers.names,               // array of member roles
					                    function (err, res) {       // callback
										    console.log(err, res);           // it should seem
									    	if (err) {
									    		reject("Could not add User");
									    	}
									    	else {
									    		resolve(true);
									    	}
					                    }
					                );
								});
							});
							return added;
						} catch (err) {
							return err;
						}

					}
				}
			}
			catch (err) {
				return err;
			}
			return false;
		}
	}

	/**
	 *  getExporters
	 *  - loads users from rokfor backend
	 **/


	module.getExporters = async function(b64mail, password, group) {
		var userdb = await module.loadUserDatabase(b64mail, password);
		if (userdb === false) {
			return false;
		} else {
            try	{
				let exporters = await new Promise((resolve, reject) => {
				    var req = module.unirest("GET", `${module.api.endpoint}exporter?filter=Book&filterId=${module.api[group].book}`);
				    req.headers({
				      "content-type": "application/json",
				      "authorization": `Bearer ${module.api.rokey}`
				    });
				    req.end(function (res) {
				      if (res.error) {
				        log.error(`Load Users Failed: ${res.error}`);
				        reject("Could not add User");
				      }
				      else {
				        resolve(res.body.Exporter.Book[module.api[group].book])
				      }
				    });
				});
				return exporters;
			} catch (err) {
				return false;
			}
		}
	}


	/**
	 *  doExport
	 *  - loads users from rokfor backend
	 **/


	module.doExport = async function(b64mail, password, exporterId, issueId) {
		var userdb = await module.loadUserDatabase(b64mail, password);
		if (userdb === false) {
			return false;
		} else {
            try	{
				let exporters = await new Promise((resolve, reject) => {
	                var req = module.unirest("POST", `${module.api.endpoint}exporter/${exporterId}`);
	                var guid = module.guidGenerator();
	                module.validcb.push(guid);
	                req.headers({
	                  "authorization": `Bearer ${module.jwt}`,
	                  "Content-Type": "application/json"
	                })
	                .type("json")
	                .send({
						"Callback": `${domain}/callback/${guid}`,
						"Mode": "issues",
						"Selection": issueId
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
				return exporters;
			} catch (err) {
				return false;
			}
		}
	}


	module.checkValidCallback = function (uid) {
       if (module.validcb.indexOf(uid) !== -1) {
       		module.validcb.splice(module.validcb.indexOf(uid), 1);
       		return true;
       }
       return false;
	}

	module.storeExport = async function(status, issueId, exportdata) {
		
		try {
		  exportdata.File = JSON.parse(exportdata.File);  
		} catch (err) {exportdata.File = {};}
		
		try {
		  exportdata.Pages = JSON.parse(exportdata.Pages);
		} catch (err) {exportdata.Pages = {};}

		log.info(exportdata);

		try {
			exportdata.Status = status;
			let _return = await new Promise((resolve, reject) => {
				var db = module.connection.database(`issue-${issueId}`);
		        db.save(`contribution-${issueId}-exports`, exportdata, async function (err, res) {
		          if (err) {
		            reject('could not store options');
		          }
		          else {
								var idData = {
									id: res._id,
									rev: res._rev
								}
								if (status == 'Complete') {
									if (storefile === true) {
										// the reference to the document in couch db that will be passed to the saveAttachment method
										for (let _file in exportdata.File) {
											try {
												await new Promise((resolve, reject) => {
													var attachmentData = {
														name: _file + '.pdf', 
														'Content-Type': 'application/pdf'
													}
													var writeStream = db.saveAttachment(idData, attachmentData, function (err, reply) {
														if (err) {
															reject(false);
															return
														}
														idData.rev = reply.rev;
														resolve(true);
													})
													request(exportdata.File[_file]).pipe(writeStream);
												});
											} catch (err) {
												log.info("could not store attachement")
											}
										}
									}
									else {
										
										// TODO: Clear existing attachments
										/*
										for (let _file in exportdata.File) {
											try {
												await new Promise((resolve, reject) => {
													db.removeAttachment(idData, _file + '.pdf', function (err, reply) {
														if (err) {
															reject(false);
															return
														}
														resolve(true);
													})
												})
											} catch (err) {
												log.info("could not remove attachement")
											}
										}*/
									}
								}
				      	resolve('ok');
		          }
		        });
		    });
			return _return;
		} catch (err) {
			return err;
		}
	}

	  /**
	   *  loadUsers
	   *  - loads users from rokfor backend
	   **/

	  module.loadUsers = function() {
	    var deferred = q.defer();
	    var req = module.unirest("GET", `${module.api.endpoint}users`);
	    req.headers({
	      "content-type": "application/json",
	      "authorization": `Bearer ${module.api.rokey}`
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

	  module.checkDatabase = function(users, uindex, deferred) {
	    deferred = deferred || q.defer();
	    uindex = uindex || 0;
	    if (users[uindex] === undefined) {
	      deferred.resolve(true);
	      return;
	    }
	    let username = users[uindex].Name;
	    let apikey = users[uindex].Key;

	    var _module = module;
	    var db = module.connection.database(`rf-${username}`);

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
	                        _module.syncIssues(username, apikey).then(function(){
	                          _module.checkDatabase(users, ++uindex, deferred)
	                        })
	                      }
	                  );
	                }
	              }
	          );
	        }
	        else {
	          log.info(`    - IssueDB Exists: rf-${username}`);
	          _module.syncIssues(username, apikey).then(function(){
	            _module.checkDatabase(users, ++uindex, deferred)
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

	  module.syncIssueBase = function(issues, username, apikey, issue_index, deferred) {
	    deferred = deferred || q.defer();
	    var _module = module;
	    var issue_index = issue_index || 0;

	    if (issues[issue_index] === undefined) {
	      deferred.resolve(true);
	      return;
	    }

	    let issueId = issues[issue_index].Id


	    var db2 = module.connection.database(`issue-${issueId}`);
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
	                        //_module.syncIssues(username, apikey)
	                        _module.syncIssueBase(issues, username, apikey, ++issue_index, deferred)
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
	                        _module.syncIssueBase(issues, username, apikey, ++issue_index, deferred)
	                    }
	                );
	              }
	              else {
	                _module.syncIssueBase(issues, username, apikey, ++issue_index, deferred)
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

	  module.syncIssues = function(username, apikey) {
	    /* TODO Download Issues and store them here... */
	    /* Sync even if db exist. */
	    var deferred = q.defer();
	    var _module = module;
	    var req = module.unirest("GET", `${module.api.endpoint}issues`);
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
	        let _db = _module.connection.database(`rf-${username}`);
	        _db.merge('issues', {data: res.body}, function (err, _res) {
	          if (err) {
	            if (err.reason === 'missing') {
	              _db.save('issues', {
	                data: res.body
	              }, function (err, res) {
	                log.info(`created issues for ${username}`)
	                if (res.body && res.body.Issues) {
	                  _module.syncIssueBase(res.body.Issues, username, apikey).then(function() {
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
	              _module.syncIssueBase(res.body.Issues, username, apikey).then(function(){
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

	  module.createJWT = function() {
	    var deferred = q.defer();
	    var req = module.unirest("POST", `${module.api.endpoint}login`);
	    var _module = module;
	    req.headers({
	      "content-type": "application/x-www-form-urlencoded"
	    });
	    req.form({
	      "username": module.api.user,
	      "apikey": module.api.rwkey
	    });
	    req.end(function (res) {
	      if (res.error) {
	        log.error(`Login Failed: ${res.error}`);
	        deferred.resolve(false);
	      }
	      else {
	        _module.jwt = res.body;
	        deferred.resolve(_module.jwt);
	      }
	    });
	    return deferred.promise;
	  }

	  /**
	   * reWatch
	   * Stops all watchers
	   * Restarts writer2rokfor
	   **/
	  module.reWatch = function() {


	      module.watchers.forEach(function(watcher){
	        watcher.stop();
	      })
	      module.watchers = [];

	      log.info(`reWatch: stopped all watchers. counting: ${module.watchers.length} after...`)

	      module.writer2rokfor();
	  }

	  module.resolveChapter = function(issueid) {
		log.info(`GET Books / Resolve default chapter`);
		let self = module;
	    return new Promise((resolve, reject) => {
			var _req = self.unirest("GET", `${self.api.endpoint}books`);
			_req.headers({
			"content-type": "application/json",
			"authorization": `Bearer ${self.api.rokey}`
			});
			_req.end(function (res) {
				if (res.error) {
					log.info(res);
					log.error("Load Issue Failed");
					reject("Load Issue Failed");
				}
				else {
					let _chapter = false;
					res.body.Books.forEach(b => {
						b.Issues.forEach(i => {
							if (i.Id == issueid) {
								b.Chapters.forEach(c => {
									if (c.Name == self.api.chaptername) {
										_chapter = c;
									}
								})
							}
						});	
					});
					resolve(_chapter);
				}
			})
		})
	  }


	  module.changesStackPush = async function(name, c) {
	    c = c || false;
	    let _module = module;
	    
	    // Add Changes to Stack if there is a change parameter

	    if (c !== false) {
	      module.changeStack.push(c);  
	      log.info(`INCOMING CHANGE: ${c.deleted ? 'DELETE' : 'UPDATE'} Stack length is now ${module.changeStack.length}`);
	      // Stop here if working changes are in progress
	      if (module.changesWorking === true) {
	        return;
	      }
	    }


	    // Get Current Changes Object: First from stack
	    
	    let changes = module.changeStack.length > 0 ? module.changeStack[0] : false;

	    // Return if there is nothing to do, reactivate state

	    if (changes === false) {
	      module.changesWorking = false;
	      return;
	    }

	    // Start Propagating Changes to Rokfor - Lock Process.

	    module.changesWorking = true;


	    // Create, Update, Delete
	    if (changes.deleted === true) {
	      log.info("DELETE Document", changes.doc.data);

	      // Await DELETE DOCUMENT
	      try {
	        await new Promise((resolve, reject) => {
	          var req = _module.unirest("DELETE", `${_module.api.endpoint}contribution/${changes.doc.data}`);
	          req.headers({
	            "content-type": "application/json",
	            "authorization": `Bearer ${_module.jwt}`
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
	                var req = module.unirest("POST", `${module.api.endpoint}issue/${issue.Id}`);
	                req.headers({
	                  "authorization": `Bearer ${module.jwt}`,
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

			else if (changes.id.indexOf('exports') !== -1) {
	            log.info(`NOTHING TO SEND TO ROKFOR AFTER CHANGES UPDATE`);
			}

	        else {

	          try {
	            await new Promise((resolve, reject) => {
	              _module.storeContribution(changes, name).then(function(){
	                resolve(true);
	              }).catch(function(err){
	                //if (_module.isLockedContribution(changes.id)) {
	                //  reject('CONTRIB LOCKED');
					//}

					var _chapter = await this.resolveChapter(changes.doc.data.issue);




	                log.info(`PUT Document ${_module.api.endpoint}contribution`);
	                var req = _module.unirest("PUT", `${_module.api.endpoint}contribution`);
	                req.headers({
	                  "content-type": "application/json",
	                  "authorization": `Bearer ${_module.jwt}`
	                });
	                req.type("json");
	                req.send({
	                  "Template": _module.api.template,
	                  "Name": changes.doc.data.name,
	                  "Chapter": _chapter.Id,
	                  "Issue": parseInt(changes.doc.data.issue),
	                  "Status": changes.doc.data.status === true ? "Draft" : "Open"
					});
	                req.end(function (res) {
	                  if (res.error) {
	                     reject("PUT FAILED");
	                  }
	                  else {

	                    let _newContribution = res.body;
	                    // module couchDB-id will be locked from now on, since it's put into rokfor.

	                    _module.locks[changes.id] = _newContribution.Id;

	                    _module.storeContribution(changes, name, _newContribution.Id).then(function(){
	                      _module.updateCouch(changes, name, _newContribution.Id).then(function(){
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

	    module.changeStack.splice(0, 1);
	    module.changesStackPush(name);

	  }


	  /**
	   * writer2rokfor
	   * Direction: Writer -> Rokfor
	   * Listen to changes within issue-* Databases
	   * Listen to CouchDB watch stream
	   **/

	  module.writer2rokfor = async function() {
	    log.info("* starting Writer -> Rokfor Sync...")
	    let _module = module;
			module.connection.databases(function(a,e){
	      e.forEach(function(name) {

	        /* Watching ISSUES Databases */

	        if (name.indexOf("issue-") !== -1) {
	          let _watcher = _module.connection.database(name).changes({since:"now", include_docs: true});
	          _watcher.on('change', function (changes) {
	            _module.changesStackPush(name, changes);
	          }.bind(name));
	          _watcher.on('error', function(err){
	            log.info("Error Ocurred", err);
	          })
	          _watcher.on('stop', function(){
	            log.info(`Stopping Watcher for db: ${this.db.split('/').splice(-1)}`);
	          })
	          _module.watchers.push(_watcher);
	        }
	      })
			});
	  }

	  /**
	   * updateCouch
	   * updates a CouchDB Document with a new RokforId, called
	   * after creating a new rokfor contribution.
	   **/

	  module.updateCouch = function(changes, dbname, id) {
	    var deferred = q.defer();
	    log.info('need to update id in CouchDB', changes.doc.data.id, id);
	    if (changes.doc.data.id !== id) {
	      let _db = module.connection.database(dbname);
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

	  module.storeContribution = function(changes, dbname, id) {

	    var deferred = q.defer();
	    id = id || changes.doc.data.id;

	    // In order to prevent multiple posting, us the lock id for a contribution
	    // if it's available. Multipe posting can happen, if a contribution does not
	    // exist within Rokfor and multiple change request happen to a non existing 
	    // Contribution while rokfor is still adding it to the database.

	    if (module.locks[changes.id]) {
	      log.info("Apply Lock")
	      id = module.locks[changes.id];
	    }


	    let _module = module;
	    
	    var req = _module.unirest("POST", `${_module.api.endpoint}contribution/${id}`);
	    req.headers({
	      "authorization": `Bearer ${_module.jwt}`,
	      "Content-Type": "application/json"
	    });
			req.type("json");
	    let payload = {
	      "Sort": changes.doc.data.sort,
	      "Status": changes.doc.data.status === true ? "Draft" : "Open",
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

	  module.syncContribution = function(rokforId) {

	      // IMPLEMENTATION NEEDED !

	  }

	return module;

}