var yaml = require('js-yaml')
    , git = require('gitty')
    , Q = require('q')
    , fs = require('fs-extra')
    , ini = require('inireader')
    , git = require('gitty');

// Check that the job type is one of the valid ones
function checkJobType(job) {
  var allowedJobs = ['linters', 'unit-tests-in-firefox',
    'marionette_js', 'gaia_ui_tests', 'build_tests'];

  return allowedJobs.indexOf(job) !== -1;
}

// Given a gaia directory and a remote (where we will push our changes),
// checks that the directoy and git remote are correct and it's a gaia
// clone.
function checkGaiaDirectory(gaiaRoot, remote) {
  // Check for the presence of the .travis.yml file
  function checkTravisPresent() {
    return Q.promise(function (resolve, reject) {
      var yml = gaiaRoot + '/.travis.yml';
      fs.exists(yml, function (exists) {
        if (exists) {
          resolve();
        } else {
          reject('No travis file found at ' + yml);
        }
      });
    });
  }

  // .git folder with the config file pointing to */gaia.git
  // and the specified remote exists in the configuration.
  // Warning: if not remote specified will take 'origin'
  function checkGitPresent(remote) {
    var GAIA_ORIGIN = 'https://github.com/mozilla-b2g/gaia.git';
    remote = remote || 'origin';
    return Q.promise(function (resolve, reject) {
      var configFile = gaiaRoot + '/.git/config';
      fs.exists(configFile, function (exists) {
        if (!exists) {
          reject('Not a valid git directory at ' + gaiaRoot);
          return;
        }

        var parser = new ini.IniReader({async: true});
        parser.on('fileParse', function() {
          var url = this.param('remote "origin"').url;
          // It must be a gaia clone so should end with gaia.git
          var suffix = 'gaia.git';
          if (url.indexOf(suffix, url.length - suffix.length) !== -1) {
            // Check that we have the specified remote
            if (!this.param('remote "' + remote + '"')) {
              reject('Could not find remote ' + remote);
            } else {
              resolve(GAIA_ORIGIN === url);
            }
          } else {
            reject('Are you sure you have a gaia clone in ' + gaiaRoot + '?');
          }
        });
        parser.load(configFile);
      });
    });
  }

  return Q.all([checkTravisPresent(), checkGitPresent(remote)]);
}

// Given a gaia working directory and a job to repeat, generates the
// travis configuration to perform just that task as many times as
// specified. Also extra global parameters can be pased.
function getNewTravisConf(gaiaRoot, jobType, globals, repetitions, branchName) {
  var ymlFile = gaiaRoot + '/.travis.yml';
  branchName = branchName || 'master';
  return Q.promise(function (resolve, reject) {
    if (!checkJobType(jobType)) {
      reject('Unknown job type ' + jobType);
      return;
    }
    try {
      fs.readFile(ymlFile, 'utf-8', function (err, data) {
        var config = yaml.safeLoad(data);
        // Just the repited job
        config.env.matrix = [];
        for (var i = 0; i < repetitions; i++) {
          config.env.matrix.push('CI_ACTION=' + jobType + ' TRY=' + i);
        }

        config.branches.only = [branchName];
        // Weird effect
        config.before_script[0] = 'export DISPLAY=:99.0';

        // New globals if needed
        if (globals && Array.isArray(globals)) {
          globals.forEach(function (global) {
            config.env.global.push(global);
          });
        }

        // Remove any notification
        delete config.notifications;

        resolve(yaml.dump(config));
      });
    } catch(e) {
      reject(e);
    }
  });
}

// Given the working directory and the new travis configuration
// saves it to the specific file in our working dir.
function saveNewTravisConf(gaiaRoot, config) {
  var ymlFile = gaiaRoot + '/.travis.yml';
  return Q.promise(function (resolve, reject) {
    fs.writeFile(ymlFile, config, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// Creates a branch in the working directory
function createBranch(gaiaRoot, branchName) {
  var repo = git(gaiaRoot);

  return Q.promise(function (resolve, reject) {
    try {
      repo.branch(branchName, function (err) {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    } catch(e) {
      reject(e);
    }
  });
}

// Perform the add and commit actions over the git repo
function addAndCommit(gaiaRoot, branchName, msg) {
  var repo = git(gaiaRoot);
  var ymlFile = gaiaRoot + '/.travis.yml';
  return Q.promise(function (resolve, reject) {
    try {
      // First checkout the new branch
      repo.checkout(branchName, function (err) {
        if (err) {
          reject(err);
          return;
        }

        // Add the changes
        repo.add([ymlFile], function (err) {
          if (err) {
            reject(err);
            return;
          }

          // Commit changes
          repo.commit(msg, function (err) {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      })
    } catch(e) {
      reject(e);
    }
  });
}

function pushBranch(gaiaRoot, remote, branchName) {
  var repo = git(gaiaRoot);

  return Q.promise(function (resolve, reject) {
    try {
      repo.push(remote, branchName, null, function (err) {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    } catch(e) {
      reject(e);
    }
  }); 
}

// Saves all the changes in a new and push that branch
// to the given remote.
function push(gaiaRoot, remote, branchName, msg) {
  // Create the new branch
    // Add and commit
      // Push the branch
  return Q.promise(function (resolve, reject) {
    createBranch(gaiaRoot, branchName).
    then(addAndCommit.call(null, gaiaRoot, branchName, msg)).
    then(pushBranch.call(null, gaiaRoot, remote, branchName).then(resolve.call(null, branchName),
     reject));
  });
  
}

var GaiaCheckIntermitent = {
  checkWorkingDir: checkGaiaDirectory,
  getNewConfiguration: getNewTravisConf,
  pushTaskBranch: function (gaiaRoot, remote, jobType, globals, repetitions) {
    return Q.promise(function (resolve, reject) {
      if (!checkJobType(jobType)) {
        reject('Unknown job type ' + jobType);
        return;
      }

      var branchName = jobType + '_' + new Date().getTime();
      var msg = 'Gaia Check Intermitents - job ' + jobType + '\n' +
        'Repetitions: ' + repetitions + '\n' +
        'With extras: ' + globals;

      getNewTravisConf(gaiaRoot, jobType, globals,
       repetitions, branchName).then(function (config) {        
        saveNewTravisConf(gaiaRoot, config).then(function (config) {
          push(gaiaRoot, remote, branchName, msg).then(resolve, reject);
        }, reject);
      }, reject);
    });
  },
};

module.exports = GaiaCheckIntermitent;
var gaiaRoot = '/Users/arcturus/Documents/dev/git/community/gaia';
var remote = 'upstream_arcturus';
var job = 'unit-tests-in-firefox';
var globals = ['APP=communications/contacts'];
GaiaCheckIntermitent.pushTaskBranch(gaiaRoot, remote, job, globals, 10).then(
  function(){
    console.log('WIN');
  }, function(err) {
    console.log('ERROR: ' + err);
  }
);


