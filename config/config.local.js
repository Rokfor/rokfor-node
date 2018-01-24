
module.exports = {
  server      : '',       // CouchDB Url
  port        : 6984,     // CouchDB Port
  username    : '',       // CouchDB Administrator Name
  userpass    : '',       // CouchDB Administrator Password
  api : {
    "endpoint" : '',      // Rokfor API Endpoint (Ending on /api/)
    "user"     : '',      // Rokfor API User (needs root level)
    "rwkey"    : '',      // Rokfor R/W Key for JWT Creation
    "rokey"    : '',      // Rokfor R/O Key
    "chapter"  : 1,       // Rokfor Chapter ID for Data Syncing
    "template" : 1,       // Rokfor Template ID for Data Syncing
    "book"     : 1        // Rokfor Book ID for Data Syncing
  },
  pollport    : 5050,     // Listener Port for Route Hook Callbacks
  loglevel    : 'debug',
  mailer      : {
    sender: 'email@sender.com',
    host: 'smtp.example.com',
    port: 587,
    secure: false, // upgrade later with STARTTLS
    auth: {
        user: 'username',
        pass: 'password'
    }
  }
}
