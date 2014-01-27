var fs = require('fs');
var geolib = require('geolib');
var path = require('path');
var sets = require('simplesets');
// Create a Timezone function that knows about all the world's time zones. Add a
// custom `strftime` format specifier `%+` that returns the time zone offset in
// milliseconds.
var tz = require('timezone')(require('timezone/zones'), function () {
  this["+"] = function () { return this.entry.offset + this.entry.save }
});

// The "shortcut" iterates the timezone polygons when they are read in, and
// determines the minimum/maximum longitude of each.  Because there are what
// we professionals refer to as "a shitload" of polygons, and because the
// naive method I use for determining which timezone contains a given point
// could in the worst case require calculations on the order of O(shitload),
// I take advantage of the fact that my particular dataset clusters very
// heavily by degrees longitude.
// TODO cache this with file and read from cached file.
var SHORTCUT_DEGREES_LATITUDE = 1;
var SHORTCUT_DEGREES_LONGITUDE = 1;
// Maybe you only care about one region of the earth.  Exclude "America" to
// discard timezones that start with "America/", such as "America/Los Angeles"
// and "America/Chicago", etc.
var EXCLUDE_REGIONS = [];

var timezoneNamesToPolygons = null;
var timezoneLongitudeShortcuts = null;
var timezoneLatitudeShortcuts = null;
var currentTzWorld;
var constructedShortcutFilePath = path.join(__dirname, 'shortcuts.json');

// Init
// by default using the provided tz_world.json file, alternativly a similar file
// can be passed ie. for debugging and testing
var init = function(tzWorldFile){
  if(!tzWorldFile) tzWorldFile = path.join(__dirname, 'tz_world.json');

  if(currentTzWorld !== tzWorldFile) {
    currentTzWorld = tzWorldFile;
    // reinit on change
    timezoneNamesToPolygons = null;
    timezoneLongitudeShortcuts = null;
    timezoneLatitudeShortcuts = null;
    constructShortcuts(tzWorldFile);
    return true;
  } else {
    return false
  }
};

var constructShortcuts = function (tzWorldFile) {
  // Construct once
    if (!((timezoneNamesToPolygons === null) || (timezoneLongitudeShortcuts === null)))
        return;
    // Try to read from cache first
    fs.readFile(path.join(__dirname, 'polys.json'), 'utf-8', function (err, data) {
        if (err)
            console.log(err);
        timezoneNamesToPolygons = JSON.parse(data);
    });

    fs.readFile(path.join(__dirname, 'lat.json'), 'utf-8', function (err, data) {
        if (err)
            console.log(err);
        timezoneLatitudeShortcuts = JSON.parse(data);
    });

    fs.readFile(path.join(__dirname, 'long.json'), 'utf-8', function (err, data) {
        if (err)
            console.log(err);
        timezoneLongitudeShortcuts = JSON.parse(data);
    });
};

var tzNameAt = function (latitude, longitude) {
  var latTzOptions = timezoneLatitudeShortcuts[Math.floor(latitude / SHORTCUT_DEGREES_LATITUDE) * SHORTCUT_DEGREES_LATITUDE];
  var latSet = new sets.Set(Object.keys(latTzOptions));
  var lngTzOptions = timezoneLongitudeShortcuts[Math.floor(longitude / SHORTCUT_DEGREES_LONGITUDE) * SHORTCUT_DEGREES_LONGITUDE];
  var lngSet = new sets.Set(Object.keys(lngTzOptions));
  var possibleTimezones = lngSet.intersection(latSet).array();
  if (possibleTimezones.length) {
    if (possibleTimezones.length === 1) {
      return possibleTimezones[0];
    } else {
      for (var tzindex in possibleTimezones) {
        var tzname = possibleTimezones[tzindex];
        var polyIndices = new sets.Set(latTzOptions[tzname]).intersection(new sets.Set(lngTzOptions[tzname])).array();
        for (var polyIndexIndex in polyIndices) {
          var polyIndex = polyIndices[polyIndexIndex];
          var poly = timezoneNamesToPolygons[tzname][polyIndex];
          var found = geolib.isPointInside({'lat': latitude, 'lng': longitude}, poly);
          if (found) {
            return tzname;
          }
        }
      }
    }
  }
  return null;
};

// Accepts [date constructor arguments ...], tzname
var dateIn = function () {
  if (arguments.length === 0) {
    return null;
  } else {
    var vargs = [], tzname, date;
    vargs.push.apply(vargs, arguments);
    tzname = vargs.pop();
    vargs.length > 1 && vargs[1]++; // zero month to humane month.
    date = vargs.length ? vargs.length == 1 ? vargs[0] : vargs.slice(0, 7) : Date.now();
    return tz(date, tzname);
  }
};

// Accepts latitude, longitude, ... where ... are arguments applicable to a "new
// Date(...)" call.
//
// Like new Date() and unlike Date.UTC(), dateAt() treats a single integer value
// as milliseconds since the epoch.
var dateAt = function () {
  var tzname = tzNameAt(arguments[0], arguments[1]);
  if (tzname) {
    // Pass any date constructors through.
    return dateIn.apply(this, Array.prototype.slice.call(arguments, 2).concat([tzname]));
  }
  return null;
};

// This will return "number of milliseconds to add to UTC to get a date in
// this time".  I know that's not a terribly obvious format, but it does let
// you go:
//   UTC standard date + offset = local date.
// Which is a little bit useful for things like when some event expressed in
// UTC happens in local time for multiple timezones around the world.
// Personally I don't get much use out of it, YMMV.
// Why milliseconds?  Because it's the time denomination of choice for JS.
//
// Now accepts a wall clock time for the location and converts the wall clock
// time to the time zone offset for the location at the given wall clock time.
//
// Like new Date() and unlike Date.UTC(), tzOffsetAt() treats a single integer
// value as milliseconds since the epoch.
var tzOffsetAt = function () {
  var vargs = [], tzname, date;
  vargs.push.apply(vargs, arguments);
  tzname = tzNameAt(vargs.shift(), vargs.shift());
  if (tzname) {
    vargs.length > 1 && vargs[1]++; // zero month to humane month.
    date = vargs.length ? vargs.length == 1 ? vargs[0] : vargs.slice(0, 7) : Date.now();
    return + tz(date, '%+', tzname);
  }
  return null;
};

// Allows you to call
// tzwhere.tzoffset(lat, long, function (error, offset) {
//   console.log(error ? error : offset);
// });
// with error handling and callback syntax, as well as
// console.log(tzwhere.tzoffset(lat, long));
// without error handling.
var wrap = function (f) {
  return function () {
    var error = null;
    var result = null;

    var callback = (typeof(arguments[arguments.length - 1]) == 'function') ? arguments[arguments.length - 1] : null;
    try {
      result = f.apply(this, callback ? Array.prototype.slice.call(arguments, 0, arguments.length - 1) : arguments);
    } catch (e) {
      error = e;
    }

    if (callback) {
      callback(error, result);
    } else if (error) {
      throw error;
    } else {
      return result;
    };
  };
}

module.exports = {
  'init': init,
  'tzNameAt': wrap(tzNameAt),
  'dateAt': wrap(dateAt),
  'dateIn': wrap(dateIn),
  'tzOffsetAt': wrap(tzOffsetAt),
};
