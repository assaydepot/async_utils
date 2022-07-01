var _ = require('underscore')._;
_.mixin( require('toolbelt') );
var node_request = require('request');
var async = require('async');
var ObjTree = require('objtree');
var fs = module.require('fs');
var command = require('./command');
var wget = require('./wget');

// https://github.com/mscdex/node-ftp
var Ftp = require('ftp');

// https://stuk.github.io/jszip/
var JSZip = require("jszip");

// https://github.com/antelle/node-stream-zip#callback-api
var StreamZip = require('node-stream-zip');

var StreamZipObject = function(path) {
  this._path = path;
  return this;
};

StreamZipObject.prototype.close = function() {
  if (this._zipStream) { this._zipStream.close(); }
  delete this._zipStream;
  return this;
};

StreamZipObject.prototype.open = function(callback) {
  const zip = new StreamZip({ file: this._path });
  zip.on('ready', function() {
    this._zipStream = zip;
    this.files = zip.entries();
    callback(null, this);
  }.bind(this));
  return this;
};

StreamZipObject.prototype.file = function(fname) {
  return this.files[fname];
};

StreamZipObject.prototype.zipunzip = function(name, callback) {
  let output = "";

  this._zipStream.stream(name, (err, stm) => {
    stm.on('data', function(data) {
      output += data;
    });

    stm.on('end', function() {
      callback(null, output);
    });
  });
};

var Download = function() {
	return Download.prototype.initialize.apply(this, arguments);
};

Download.prototype.initialize = function(obj, parent) {
  _.keys(obj).forEach(function(k) { this[k] = obj[k]; }, this);
  this.protocol = parent.protocol || 'zip';
  this.tmp = parent.tmp || '/tmp';
	this.path = [this.tmp || '/tmp', this.name].join('/');
	this.directory = this.path.split('/').length > 1
	? this.path.split('/').slice(0, this.path.split('/').length-1).join('/')
	: '';

	if (!this.fname && this.name) {
		this.fname = this.name.replace('.gz', '')
	}

	if ({zip: true}[this.protocol]) {
		this.zipname = parent.zipname;
	}
  return this;
};

Download.prototype.unlink = function() {
	delete this.JSZip;
	return this;
};

Download.prototype.gunzip = function(callback) {
  // zip library used with ftp download.
  var zlib = require('zlib');
	var self = this;

	if (this.name.split(/.gz/).length < 2) {
		console.log('[FTP] info: skipping...', this.name);
		setTimeout(function() {
			callback({code: 'unprocessable_entity', status: 403, message: 'Not a ".gz" file.'});
		}, 100);
	} else {
		fs.createReadStream( self.path )
		.pipe( zlib.createGunzip() )
		.pipe( fs.createWriteStream( self.path.replace('.gz', '') )

			.on('close', function() {
				fs.unlink( self.path, callback);
			}) );
	}
	return this;
};

const _zipunzip = function(callback) {
	var self = this;

	var writable = fs.createWriteStream( self.path );
	// read a zip file
	this.JSZip
	.file( self.name )
	.nodeStream()
	.pipe( writable )
	.on('finish', function () {
	    // JSZip generates a readable stream with a "end" event,
	    // but is piped here in a writable stream which emits a "finish" event.
	    if (self.verbose) console.log('[ZIP/unzip] info: saved.', self.name);
		self.unzipped = true;
		writable.end();
		callback(null, self);
	})
	.on('error', function(err) {
		console.log('[ZIP/unzip] error:', err);
		callback(err);
	})
	return this;
};

Download.prototype.zipunzip = function(callback) {
	var self = this;

  if (this.JSZip && this.JSZip instanceof StreamZipObject) {
    return this.JSZip.zipunzip(this.name, callback);
  }

	if (this.inflate) {
		if (this.directory) {
			fs.mkdir(this.directory, function(err) {
				if (err && err.code !== "EEXIST") {
					throw new Error('[Download] fatal: "mkdir" failed not existing.')
				}
				_zipunzip.call(self, callback);
			});
		} else {
			_zipunzip.call(self, callback);
		}
	} else {
		this.JSZip.file(this.name).async("string").then(function (data) {
			self.unzipped = true;
			callback(null, data);
		}, callback);
	}
	return this;
};

Download.prototype.unzip = function() {
	return {
		ftp: Download.prototype.gunzip,
		zip: Download.prototype.zipunzip
	}[this.protocol].apply(this, arguments);
};

Download.prototype.cleanup = function(callback) {
	var cleanupOne = function(path, next) {
		fs.stat(path, function(err, stats) {
			if (stats) {
				return fs.unlink( path, function(err) {
					next()
				});
			}
			return next()
		});
	};

	if (this.unzipped && this.inflate) {
		return cleanupOne(this.path.replace('.gz', ''), callback);
	}
	delete this.JSZip.files[this.name];
  Object.keys(this).forEach(function(key) {
    delete this[key];
  }, this);
	process.nextTick(callback);
};

Download.prototype.byLine = function() {
  // https://github.com/jahewson/node-byline
  var byLine = require('byline');

	let stream = byLine( fs.createReadStream(this.path.replace('.gz', ''), { encoding: 'utf8' }) );
  return {
    stream: stream,
    start: function(lineHandler, callback) {
    	stream.on('data', function(line) {
    	  lineHandler.line.call(stream, line);
    	})
    	.on('error', callback)
    	.on('end', function() {
    		callback(null, 'end');
    	})
    	.on('close', function() {
    		callback(null, 'closed');
    	});
    }
  }
};

Download.prototype.readByLine = function(lineHandler, callback) {
	var self = this;

	this.byLine( this.path.replace('.gz', '') )
  .stream
	.on('data', function(line) {
	  lineHandler.line(line, callback);
	})
	.on('error', callback)
	.on('end', function() {
		callback(null, 'end');
	})
	.on('close', function() {
		callback(null, 'closed');
	});
};

Download.prototype.readXML = function(options, callback) {
	if (typeof options === 'function') {
		callback = options;
		options = {};
	} else {
		options = options || {};
	}
	var toJson = new ObjTree();
	if (options.force_array) {
		toJson.force_array = options.force_array;
	}

	fs.readFile(this.path.replace('.gz', ''), 'utf-8', function(err, data) {
		data = toJson.parseXML( data, _.clean({ errorHandler: options.errorHandler }));
		callback(err, data);
	});
};

var protocol_methods = {

	// use the 'protocol' value (ftp or zip) to decode.
	ftp: {
		open: function(response) {
			var c = new Ftp();

			c.on('error', function(err) {
				console.log('[FTP] error:', err && err.code || err);
				response(err);
			});

			c.on('ready', function() {
        let self = this;
				async.auto({
					cwd: function(next) {
						c.cwd(self.path, next);
					},
					pwd: ['cwd', function(next) {
						c.pwd(next);
					}],
					response: ['pwd', function(next, data) {
						if (data.pwd.slice(1) !== self.path) {
							throw new Error('Unable to connect, PWD Failed.');
						}
						response( c );
					}]
				});
			});

			_.wait(2 * Math.random(), function() {
				c.connect( _.pick(this, 'host', 'password' ) );
			}, this);

			return this;
		},
		contents: function(response) {
			var self = this;
			var c = new Ftp();

			if (self.verbose) console.log('[FTP] info: ', self.host, self.path);
			this.open(function(connection) {

				if (connection && connection.list) {
					return connection.list(function(err, ftplist) {
						connection.end();
						response(err, self.add( ftplist ));
					});
				}

				// return an error
				response(connection);
			});
			return this;
		},

		get: function(ftpItem, next) {
			var self = this;

			if (self.verbose) console.log('[FTP] info: downloading...', ftpItem.name);
			this.open(function(connection) {
				connection.get(ftpItem.name, function(err, stream) {
					if (err) {
						connection.end();
						if (self.verbose) console.log('[FTP] error: streaming...', err.message);
						return next(err);
					};

					stream
					.once('close', function(err) {
						self.downloaded.push( ftpItem.name );
						connection.end();
						next(err);
					})
					.pipe(fs.createWriteStream( ftpItem.path ));
				});
			});
			return this;
		}
	},
	zip: {

		contents: function(callback) {
			var self = this;

			async.auto({
				fetch: function(next) {
					self.get(next);
				},
				handle: ['fetch', function(next, data) {

					// read a zip file
					fs.readFile(self.zipname, function(err, data) {
					    if (err) throw new Error(err.message);

					    new JSZip().loadAsync(data).then(function (zip) {
							  return callback(null, self.add( zip ));
					    });
					});
				}]
			});
		},
		get: function(callback) {
			if (this.downloaded) {
				_.wait(1, function() {
					callback(null, this);
				}, this);
				return this;
			}

			var self = this;
			var file = fs.createWriteStream( self.zipname );
			node_request.get({
				uri: [this.hostname, this.path].join('/'),
				encoding: null
			}, function(response) {
				if (self.verbose) console.log('[ZIP] info: Piping...');
			})
			.pipe( file )
			.on('error', function(err) {
				console.log('[ZIP] error:', err.message);
				callback(err);
			});

			file.on('finish', function() {
				file.close(function() {
					if (self.verbose) console.log('[ZIP] info: Finished Piping.');
					self.downloaded = true;
					callback(null, self);
				}); // close() is async, call cb after close completes.
			});

			return this;
		}
	},
	stream: {

		contents: function(callback) {
			var self = this;

			async.auto({
				fetch: function(next) {
					self.get(next);
				},
				handle: ['fetch', function(next, data) {
          debugger;
          new StreamZipObject(self.zipname).open(function(err, zip) {
            callback(null, self.add( zip ));
          });
				}]
			});
		},
		get: function(callback) {
			if (this.downloaded) {
				_.wait(0.01, function() {
					callback(null, this);
				}, this);
			} else {
        console.log(`info: Downloading .zip file using "wget" ${this.hostname}/${this.path} -O ${this.zipname}`)
        wget(`${this.hostname}/${this.path}`, this.zipname)
        .on('error', function(err) {
          console.log(`info: Failed. Error: ${err.message || err.toString()}, ${_.memory()}`);
          callback(err);
        })
        .on('end', function(output) {
          console.log(`info: Completed. ${_.memory()}`);
          callback(null, output);
        });
			}
			return this;
		}
	}
};

var DownloadObject = function( items, config, handler ) {

	config = _.chain(config || {}).defaults({
		tmp: '/tmp',
		limit: undefined,
		downloaded: config.protocol == 'ftp' ? [] : false,
		verbose:false,
		concurrency: 1,
		inflate: true,
    protocol: 'zip'
	}).clone().value();

  _.each(config, function(value, key) {
    this[key] = value;
  }, this);

  _.each(protocol_methods[handler], function(value, key) {
    this[key] = _.bind(value, this);
  }, this);

  if (items && items.length) {
    DownloadObject.prototype.add.call(this, items);
  }
	return this;
};

DownloadObject.prototype.addOne = function(file, zipObject) {
	return new Download( {
		fname: _.last(file.split('/')),
		name: file,
		JSZip: zipObject,
		verbose: this.verbose,
		inflate: this.inflate
	}, this);
};

DownloadObject.prototype.add = function(zipObject) {
	var self = this;

  if (zipObject) {
    if (zipObject.files && this.protocol === 'zip') {
  		this._files = _.keys(zipObject.files).map(function(file) {
  			return self.addOne(file, zipObject);
  		});
  		this._index = _.firstIndexByKey(this._files, 'fname');
  	} else if (this.protocol === 'ftp') {
  		this._files = (zipObject || []).map(function(item) {
  			return new Download( item, self );
  		});
  	}
  }

	return this;
};

DownloadObject.prototype.files = function() {
	if ({ftp:true}[this.protocol]) {
		return this._files.filter(function(item) {
			return !item.name.match(/.md5/) && !item.name.match(/.txt/);
		}).slice(0, this.limit);
	}
	return this._files.slice(0, this.limit);
};

DownloadObject.prototype.length = function() {
	return this.files().length;
};

DownloadObject.prototype.reverse = function() {
	this.files.reverse();
	return this;
};

DownloadObject.prototype.each = function(fN, callback, context) {
	async.eachLimit(DownloadObject.prototype.files.apply(this), this.concurrency, _.bind(fN, context || this), callback);
	return this;
};

DownloadObject.prototype.unzipAll = function(handler, callback) {
	this.each(function(item, next) {
		item.unzip(function(err) {
			if (!err && handler) {
				return handler.call(item, next);
			}
			next();
		});
	}, callback);
};

DownloadObject.prototype.unzip = function(fname, callback) {
  if (!this._index[fname]) return process.nextTick( callback );
  this._index[fname].unzip(callback);
};

DownloadObject.prototype.cleanup = function(callback, keep) {
	var self = this;

	this.each(function(item, next) {
		item.cleanup(next);
	}, function(err) {

		if ({zip: true}[self.protocol]) {

  		self._files = {};
      self._index = {};
      if (self._zipStream) {
        self._zipStream.close();
      }
			if (!keep) return fs.unlink( self.zipname, callback );
		}
		process.nextTick(callback);
	});
};

var Stream = function(config) {
	config = _.defaults(config || {}, {tmp: '/tmp', verbose: false, protocol: 'zip'});
	config.zipname = [config.tmp || '/tmp', config.fname].join('/');
	return new DownloadObject(null, config, 'stream');
};

var ZIP = function(config) {
	config = _.defaults(config || {}, {tmp: '/tmp', verbose: false, protocol: 'zip'});
	config.zipname = [config.tmp || '/tmp', config.fname].join('/');
	return new DownloadObject(null, config, 'zip');
};

var FTP = function(config) {
	config = _.defaults(config || {}, {tmp: '/tmp', verbose: false, protocol: 'ftp', path: ''});
	return new DownloadObject([], config, 'ftp')
};

module.exports = {
	DownloadObject: DownloadObject,
	Download: Download,
	FTP: FTP,
	ZIP: ZIP,
	Stream: Stream
};




