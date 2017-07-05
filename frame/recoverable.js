'use strict'
var Looper = require('looper')
var filesizeCodecs = require('./filesizecodecs')

module.exports = function (blocks, blockSize, filesizeCodec) {
  if (typeof filesizeCodec === 'number') {
    filesizeCodec = filesizeCodecs[filesizeCodec]
    if (!filesizeCodec) throw Error('Invalid number of bits for filesize')
  }
  filesizeCodec = filesizeCodec || filesizeCodecs[32]
  var fsw = filesizeCodec.byteWidth

  function frame(data, start) {
    var _start = start
    var length = data.reduce(function (total, value) { return total + value.length }, 0)
    var b = new Buffer(length + data.length * (8+fsw))
    var offset = 0
    for(var i = 0; i < data.length; i++) {
      var buf = data[i]
      b.writeUInt32BE(buf.length, 0 + offset) //start
      buf.copy(b, 4+offset, 0, buf.length)
      b.writeUInt32BE(buf.length, 4+buf.length + offset) //end
      filesizeCodec.encode(b, start+=buf.length+(8+fsw), 8+buf.length + offset) //length of the file, if valid
      frame.offset = _start + offset
      offset += buf.length + (8 + fsw)
    }
    return b
  }

  function getMeta (offset, cb) {
    blocks.readUInt32BE(offset, function (err, len) {
      if(err) return cb(err)

      //read the length of the previous item.
      //unless this falls right on the overlap between
      //two blocks, this will already be in the cache,
      //so will be just a mem read.
      if(offset === 0)
        next(4, 4+len, -1, (fsw+len+8))
      else
        blocks.readUInt32BE(offset - (4+fsw), function (err, prev_len) {
          if(err) return cb(err)
          next(offset+4, offset+4+len, offset-(prev_len+8+fsw), offset+(len+8+fsw))
        })

      function next (start, end, prev, next) {
        blocks.read(start, end, function (err, value) {
          cb(err, value, prev, next)
        })
      }
    })
  }

  function restore (cb) {
    blocks.offset.once(function (offset) {
      if(offset === 0) return cb(null, -1) //the file is just empty!

      var end = offset //the very end of the file!
      var again = Looper(function () {
        filesizeCodec.decodeAsync(blocks, end-fsw, function (err, _end) {
          if(_end != end) {
            if((--end) >= 0) again()
            //completely corrupted file!
            else blocks.truncate(0, next)
          }
          else {
            if(end != offset)
              blocks.truncate(end-fsw, next)
            else
              next()
          }
        })
      })
      again()
      function next () {
        blocks.readUInt32BE(end-(4+fsw), function (err, length) {
          if(err) cb(err)
          else cb(null, end-(length+8+fsw)) //start of the last record
        })
      }
    })
  }

  return {
    frame: frame, getMeta: getMeta, restore: restore
  }
}

