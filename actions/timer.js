var sprintf = require("sprintf").sprintf;

var timers = [];

function init(ctx) {
    // Fetch all incomplete timers from database
    ctx.db.view("app/timers", {key: false}, function(err, timers) {
        if (err) {
            return console.log(err);
        }

        // Start timers again
        timers.forEach(function(timer) {
            _start(timer, ctx);
        });
    });
}

function start(name, duration, ctx) {
    var timer = {
        type: "timer",
        name: name,
        start: Date.now(),
        duration: _getDuration(duration),
        owner: ctx.req.source.nick,
        replyTo: ctx.req.replyTo,
        req: ctx.req._id,
        completed: false
    };

    // Save timer to db
    ctx.db.save(timer, function(err, res) {
        if (err) {
            return console.log(err);
        }
        timer._id = res.id;
        // Start timer
        _start(timer, ctx);
    });
}

function _getDuration(input) {
    var duration = _parseDuration(input);
    if (duration === 0) {
        duration = _parseDate(input);
    }
    return duration;
}

function _parseDuration(input) {
    var t = {
        s: 1000,
        m: 1000 * 60,
        h: 1000 * 60 * 60,
        d: 1000 * 60 * 60 * 24,
        w: 1000 * 60 * 60 * 24 * 7,
        y: 1000 * 60 * 60 * 24 * 365
    }

    var re = /^(?:(\d+)y)?(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i;
    var time = re.exec(input);
    
    var sum = 0;
    sum += t.y * (time[1] || 0);
    sum += t.w * (time[2] || 0);
    sum += t.d * (time[3] || 0);
    sum += t.h * (time[4] || 0);
    sum += t.m * (time[5] || 0);
    sum += t.s * (time[6] || 0);
    
    return sum;
}

function _parseDate(input) {
    var re = /^(?:(?:(\d{1,2})[\/.\\-](\d{1,2})(?:[\/.\\-]((?:\d{2}|\d{4})))?(?:\D(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?)|(?:(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?))$/;
    var time = re.exec(input);
    
    var year, month, day, hour, minute, second;
    var future, now;
  
    var curDate = new Date();
    var unixCurDayOfMonth = new Date(curDate.getFullYear(), curDate.getMonth(), curDate.getDate()).getTime();
    var unixCurTime = curDate.getTime();
    
    if (time) {
        var yearIsNotDefined = (typeof time[3] === 'undefined');
        var dateIsNotDefined = (typeof time[1] === 'undefined');
       
        year = parseInt(time[3] || curDate.getFullYear(), 10);
        if (year < 100) {
        	year += 2000;
        }
        
        month = parseInt(time[2] || curDate.getMonth()+1, 10);
        day = parseInt(time[1] || curDate.getDate(), 10);
        hour = parseInt(time[4] || time[7] || 0, 10);
        minute = parseInt(time[5] || time[8] || 0, 10);
        second = parseInt(time[6] || time[9] || 0, 10);
        
        var unixReqTime = new Date(curDate.getFullYear(), curDate.getMonth(), curDate.getDate(), hour, minute, second).getTime();
        if ((unixCurTime > unixReqTime) && dateIsNotDefined) {
            day += 1;
        }
        
        var unixReqDayOfMonth = new Date(year, month-1, day).getTime();
        var todayIsAfterRequestedDay = (unixCurDayOfMonth > unixReqDayOfMonth);
        var todayIsSameAsRequestedDayButEarlierInTheDay = (unixReqDayOfMonth == unixCurDayOfMonth && unixReqTime < unixCurTime);
        if ((todayIsAfterRequestedDay || todayIsSameAsRequestedDayButEarlierInTheDay) && yearIsNotDefined) {
            year += 1;
        }
        
        future = new Date(year, month-1, day, hour, minute, second).getTime();
    }
    else {
        future = 0;
    }
    
    now = Date.now();
    
    if (future - now < 0) {
        return 0;
    }
    else {
        return future - now; // milli
    }
}

function _start(timer, ctx) {
    // Start timer, add cancel function and push the timer object to the global timers array
    timer.cancel = setTimeout2(timerCompleted, remainingDuration(timer));
    timers.push(timer);

    // If there is a callback it means that this is a "live" request (i.e. not restored from the db).
    if (ctx.callback) {
        // Lets send a confirmation back to the user that the timer has started
        ctx.callback(sprintf("%s: Timer '%s' has started. Will complete at %s", timer.owner, timer.name, formatDate(completionDate(timer))));
    }

    function timerCompleted() {
        // We cant rely on having a callback at this point as the timer could have been restored from the db.
        // Lets configure the response manually and use saveResponse instead.
        var response = {
            type: "response",
            req: timer.req,
            message: sprintf("%s: Timer '%s' completed", timer.owner, timer.name),
            target: timer.replyTo
        };

        ctx.saveResponse(response, function(id) {
            if (id) {
                markAsCompleted(timer, ctx);
            }
        });
    }
}

function cancel(index, ctx) {
    if (index.toLowerCase() == "last") {
        index = timers.length - 1;
    }
    var timer = timers[index];
    if (!timer) {
        return ctx.callback("Invalid timer index");
    }
    timer.cancel();
    markAsCompleted(timer, ctx, function() {
        ctx.callback(sprintf("Timer '%s' is canceled", timer.name));
    });
}

function list(ctx) {
    var result = timers.map(function(timer, index) {
        return sprintf("[%d] <%s> %s %s", index, timer.owner, timer.name, formatDate(completionDate(timer)));
    });

    if (result.length === 0) {
        result.push("No timers currently active");
    }
    ctx.callback(result);
}

// Helper functions

// setTimeout replacement with no signed 32-bit limit
// returns cancel function instead of an id
function setTimeout2() {
    var max = Math.pow(2, 32) / 2 - 1;
    var currentId;

    function st(callback, duration) {
        var remaining = 0;

        if (duration > max) {
            remaining = duration - max;
            duration = max % duration;
        }

        currentId = setTimeout(function() {
            return (remaining > 0) ? st(callback, remaining) : callback();
        }, duration);
    }
    st.apply(this, arguments);
    
    return function() {
        clearTimeout(currentId);
    };
}

function remainingDuration(timer) {
    return (timer.start + timer.duration) - Date.now();
}

function completionDate(timer) {
    return new Date(timer.start + timer.duration);
}

function formatDate(d) {
    return sprintf("%04d-%02d-%02d %02d:%02d:%02d", d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}

function markAsCompleted(timer, ctx, callback) {
    ctx.db.merge(timer._id, {completed: true}, function(err, res) {
        if (err) {
            console.log(err);
        }
        deleteTimer(timer._id);
        if (callback) {
            callback();
        }
    });
}

function deleteTimer(id) {
    timers = timers.filter(function(timer) {
        return timer._id !== id;
    });
}

module.exports = {
    init: init,
    start: start,
    list: list,
    cancel: cancel
};
