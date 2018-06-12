const dotenv = require('dotenv').config();
const webpush = require('web-push');
const Pusher = require('pusher');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const Datastore = require('nedb');
const jwt = require('jsonwebtoken');
const ICAL = require('ical.js');
const cors = require('cors');

const gcmServerKey = process.env.GCM_SERVER_KEY;
webpush.setGCMAPIKey(gcmServerKey);

const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};

webpush.setVapidDetails(
  process.env.VAPID_MAIL_TO,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

const db = new Datastore({
  filename: path.join(__dirname, 'subscription-storage.db'),
  autoload: true
});

const calendarDB = new Datastore({
  filename: path.join(__dirname, 'calendar-items.db'),
  autoload: true
})

function saveSubscriptionToDatabase(subscription) {
  return new Promise(function(resolve, reject) {
    db.insert(subscription, function(err, newDoc) {
      if (err) {
        reject(err);
        return;
      }

      resolve(newDoc._id);
    });
  });
};

function getSubscriptionsFromDatabase(id) {
  return new Promise(function(resolve, reject) {
    db.findOne({user_id: id}, function(err, docs) {
      if (err) {
        reject(err);
        return;
      }

      resolve(docs);
    })
  });
}

function deleteSubscriptionFromDatabase(subscriptionId) {
  return new Promise(function(resolve, reject) {
  db.remove({_id: subscriptionId }, {}, function(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

const isValidSaveRequest = (req, res) => {
  if (!req.body || !req.body.endpoint) {
    res.status(400);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({
      error: {
        id: 'no-endpoint',
        message: 'Subscription must have an endpoint.'
      }
    }));
    return false;
  }
  return true;
};

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.text());
app.use(bodyParser.urlencoded({ extended: false }))

app.post('/api/save-subscription/', function (req, res) {
  if (!isValidSaveRequest(req, res)) {
    return;
  }

  return saveSubscriptionToDatabase(req.body)
  .then(function(subscriptionId) {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ data: { success: true } }));
  })
  .catch(function(err) {
    res.status(500);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({
      error: {
        id: 'unable-to-save-subscription',
        message: 'The subscription was received but we were unable to save it to our database.'
      }
    }));
  });
});

app.post('/api/get-subscriptions/', function (req, res) {
  // TODO: This should be secured / not available publicly.
  //       this is for demo purposes only.

  return getSubscriptionsFromDatabase(req.body.user_id)
  .then(function(subscriptions) {
    const reducedSubscriptions = subscriptions.map((subscription) => {
      return {
        id: subscription._id,
        endpoint: subscription.endpoint
      }
    });

    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ data: { subscriptions: reducedSubscriptions } }));
  })
  .catch(function(err) {
    res.status(500);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({
      error: {
        id: 'unable-to-get-subscriptions',
        message: 'We were unable to get the subscriptions from our database.'
      }
    }));
  });
});

const triggerPushMsg = function(subscription, dataToSend) {
  const options = { TTL: 60 }

  return webpush.sendNotification(subscription, dataToSend, options)
  .catch((err) => {
    if (err.statusCode === 410) {
      return deleteSubscriptionFromDatabase(subscription._id);
    } else {
      console.log('Subscription is no longer valid: ', err);
    }
  });
};

app.post('/api/trigger-push-msg/', function (req, res) {
  // NOTE: This API endpoint should be secure (i.e. protected with a login
  // check OR not publicly available.)
  const dataToSend = JSON.stringify(req.body);

  return getSubscriptionsFromDatabase(req.body.user_id)
  .then(function(subscription) {
    let promiseChain = Promise.resolve();

    promiseChain = promiseChain.then(() => {
      return triggerPushMsg(subscription, dataToSend)
    })

    return promiseChain;
  })
  .then(() => {
    res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ data: { success: true } }));
  })
  .catch(function(err) {
    res.status(500);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({
      error: {
        id: 'unable-to-send-messages',
        message: `Unable to send message to subscription : ` +
          `'${err.message}'`
      }
    }));
  });
});

// START PUSHER

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_PUBLIC_KEY,
  secret: process.env.PUSHER_SECRET_KEY,
  cluster: 'eu',
  encrypted: true
});

app.post('/pusher/auth/presence', function (req, res) {
  var socketId = req.body.socket_id;
  var channel = req.body.channel_name;
  var presenceData = {
      user_id: req.body.id
  };
  var auth = pusher.authenticate(socketId, channel, presenceData);
  res.send(auth);
});

app.post('/pusher/auth/private', function (req, res) {
  var socketId = req.body.socket_id;
  var channel = req.body.channel_name;
  var auth = pusher.authenticate(socketId, channel);
  res.send(auth);
});

// END PUSHER

// START ICAL

function saveCalendarItem(item) {
  return new Promise(function(resolve, reject) {
    calendarDB.insert(item, function(err, newDoc) {
      if (err) {
        reject(err);
        return;
      }

      resolve(newDoc._id);
    });
  });
};

function getCalendarItem(id) {
  return new Promise(function(resolve, reject) {
    calendarDB.find({user_id: id}, function(err, docs) {
      if (err) {
        reject(err);
        return;
      }

      resolve(docs);
    })
  });
}

app.post('/ical/add-calendar-item', function (req, res) {
  return saveCalendarItem(req.body)
  .then(function(calendarItemId) {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ data: { success: true } }));
  })
  .catch(function(err) {
    res.status(500);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({
      error: {
        id: 'unable-to-save-calendar-item',
        message: 'The calendar item was received but could not be saved to our database.'
      }
    }));
  });
});

app.get('/ical/subscribe', function (req, res) {
  if (req.query && req.query.token) {
    jwt.verify(req.query.token, process.env.CAREN_ZORGT_SECRET_KEY, (err, decoded) => {
      if (!err) {
        return getCalendarItem(decoded.caren_id)
        .then(calendarItems => {
          let comp = new ICAL.Component(['vcalendar', [], []])
          comp.updatePropertyWithValue('calscale', 'GREGORIAN')
          comp.updatePropertyWithValue('version', '2.0')
          
          for (item in calendarItems) {
            let description = (calendarItems[item].url) ? calendarItems[item].description + ' Link: ' + calendarItems[item].url : calendarItems[item].description

            let vevent = new ICAL.Component('vevent')
            let event = new ICAL.Event(vevent)
            event.summary = calendarItems[item].title
            event.startDate = ICAL.Time.fromString(calendarItems[item].startDate)
            event.endDate = ICAL.Time.fromString(calendarItems[item].endDate)
            event.description = description
            comp.addSubcomponent(vevent)
          }

          console.log(comp.toString())
          
          res.status(200)
          res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
          res.send(comp.toString())

        })
      } else {
        console.log('Error: ', err)
        res.status(500)
        res.send(JSON.stringify({
          error: {
            id: 'unable-to-build-calendar',
            message: 'The calendar token was received but could not be processed'
          }
        }));
      }
    })
  }
});

// END ICAL

const port = process.env.PORT || 9012;

const server = app.listen(port, function () {
  console.log('Running on http://localhost:' + port);
});