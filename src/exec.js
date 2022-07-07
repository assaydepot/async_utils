var _ = require('underscore')._;
const { exec } = require("child_process");

module.exports = function(commandStr, callback) {
  exec(commandStr, (error, stdout, stderr) => {
      if (error) {
          console.log(`error: ${error.message}`);
          return callback(error);
      }
      if (stderr) {
          console.log(`stderr: ${stderr}`);
          return callback(true);
      }
      callback(null, stdout);
  });
};
