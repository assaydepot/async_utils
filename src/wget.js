var wget = require('wget');

module.exports = function(src, output) {
  let progress_so_far;

  var download = wget.download(src, output);

  download.on('progress', function(progress) {
    if (Math.floor(progress * 100) > Math.floor(progress_so_far * 100)) {
      console.log(`[wget] info: ${src}, ${output}, Progress: ${(Math.floor(progress * 1000)/1000) * 100}%`)
    }

    progress_so_far = progress;
  });

  return download;
};

