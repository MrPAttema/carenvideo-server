const dotenv = require('dotenv').config();
const webpush = require('web-push');
const Pusher = require('pusher');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const Datastore = require('nedb');
const jwt = require('jsonwebtoken');
const ics = require('ics');
const cors = require('cors');

/**
 * Firebase Cloudmessaging Console key
 */
const gcmServerKey = process.env.GCM_SERVER_KEY;
webpush.setGCMAPIKey(gcmServerKey);

/**
 * VAPID keys
 */
const vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};

/**
 * Add VAPID keys and email adress to webpush instance.
 */
webpush.setVapidDetails(
  process.env.VAPID_MAIL_TO,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

/**
 * Database instance used for the push notification subscriptions.
 */
const db = new Datastore({
  filename: path.join(__dirname, 'subscription-storage.db'),
  autoload: true
});

/**
 * Database instance used for the calendar items.
 */
const calendarDB = new Datastore({
  filename: path.join(__dirname, 'calendar-items.db'),
  autoload: true
})

/**
 * Saves subscription to the database and resolves the id.
 * @param {object} subscription 
 */
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

/**
 * Gets one subscription from the database for a specific user.
 * @param {Number} id 
 */
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

/**
 * Delete a subscription from the database.
 * @param {String} subscriptionId 
 */
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

/**
 * Checks whether a request has an endpoint.
 * @param {Object} req 
 * @param {Object} res 
 * @returns {Boolean}
 */
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

/**
 * Declare express app and add CORS + bodyparser
 */
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.text());
app.use(bodyParser.urlencoded({ extended: false }))

/**
 * Save subscription endpoint
 */
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

/**
 * Get subscriptions endpoint
 */
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

/**
 * Triggers a web push notifiation for a subscription and sends data with it.
 * @param {Object} subscription 
 * @param {Object} dataToSend 
 */
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

/**
 * Trigger web push notification with a message endpoint.
 */
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
/**
 * Pusher initialization.
 */
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_PUBLIC_KEY,
  secret: process.env.PUSHER_SECRET_KEY,
  cluster: 'eu',
  encrypted: true
});

/**
 * Pusher presence channel authentication endpoint.
 */
app.post('/pusher/auth/presence', function (req, res) {
  var socketId = req.body.socket_id;
  var channel = req.body.channel_name;
  var presenceData = {
      user_id: req.body.id
  };
  var auth = pusher.authenticate(socketId, channel, presenceData);
  res.send(auth);
});

/**
 * Pusher private channel authentication endpoint.
 */
app.post('/pusher/auth/private', function (req, res) {
  var socketId = req.body.socket_id;
  var channel = req.body.channel_name;
  var auth = pusher.authenticate(socketId, channel);
  res.send(auth);
});

// END PUSHER

// START ICAL

/**
 * Save a calendar item to the database and resolves the item id.
 * @param {Object} item 
 */
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

/**
 * Gets calendar items from the database for a specific user id.
 * @param {Number} id 
 */
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

/**
 * Gets all the calendar items from the database for those added by a specific user.
 * @param {Number} id 
 */
function getCalendarItems(id) {
  return new Promise(function(resolve, reject) {
    calendarDB.find({added_by: id}, function(err, docs) {
      if (err) {
        reject(err);
        return;
      }

      resolve(docs);
    })
  })
}

/**
 * Updates a calendar item.
 * @param {Number} id 
 * @param {Object} item 
 */
function updateCalendarItem(id, item) {
  return new Promise(function(resolve, reject) {
    calendarDB.update({_id: id}, { $set: { 
        user_id: item.user_id,
        title: item.title,
        description: item.description,
        startDate: item.startDate,
        endDate: item.endDate,
        url: item.url,
        added_by: item.added_by
      } }, {}, function (err, docs) {
      if (err) {
        reject(err)
        return
      }

      resolve(docs)
    })
  })
}

/**
 * Deletes a calendar item.
 * @param {String} id 
 */
function deleteCalendarItem(id) {
  return new Promise(function(resolve, reject) {
    calendarDB.remove({ _id: id }, {}, function (err, numRemoved) {
      if (err) {
        reject(err)
        return
      }

      resolve(numRemoved)
    })
  })
}

/**
 * Add calendar item endpoint
 */
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

/**
 * Get calendar items endpoint.
 */
app.get('/ical/get-calendar-items', function (req, res) {
  console.log('hoi')
  return getCalendarItems(Number(req.query.user_id))
  .then(calendarItems => {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ data: { items: calendarItems } }));
  })
  .catch(err => {
    res.status(500);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({
      error: {
        id: 'unable-to-load-calendar-item',
        message: 'The calendar items could not be loaded.'
      }
    }));
  })
})

/**
 * Update calendar item endpoint
 */
app.post('/ical/update-calendar-item', function (req, res) {
  return updateCalendarItem(req.body.id, req.body.item)
  .then(updatedItem => {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ data: { success: true } }));
  })
  .catch(err => {
    res.status(500);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({
      error: {
        id: 'unable-to-edit-calendar-item',
        message: 'The calendar items could not be edited.'
      }
    }));
  })
})

/**
 * Delete calendar item endpoint.
 */
app.post('/ical/delete-calendar-item', function (req, res) {
  return deleteCalendarItem(req.body.id)
  .then(deletedItem => {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({ data: { success: true } }));
  })
  .catch(err => {
    res.status(500);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({
      error: {
        id: 'unable-to-delete-calendar-item',
        message: 'The calendar item could not be deleted.'
      }
    }));
  })
})

/**
 * iCalendar subscription endpoint for Carenzorgt.nl
 */
app.get('/ical/subscribe', function (req, res) {
  if (req.query && req.query.token) {
    jwt.verify(req.query.token, process.env.CAREN_ZORGT_SECRET_KEY, (err, decoded) => {
      if (!err) {
        return getCalendarItem(decoded.caren_id)
        .then(calendarItems => {
          const events = []

          for (item in calendarItems) {
            const startDate = []
            const endDate = []
            
            // TODO: Use REGEX to make this somewhat more beautyful...
            let splitDate = calendarItems[item].startDate.split("-")
            startDate.push(Number(splitDate[0]))
            startDate.push(Number(splitDate[1]))
            splitDate = splitDate[2].split("T")
            startDate.push(Number(splitDate[0]))
            splitDate = splitDate[1].split(":")
            let initalHour = Number(splitDate[0])
            let offset = splitDate[2].split("+")
            let hour = 00
            if (offset.length >= 2) {
              hour = initalHour + Number(offset[1])
            } else {
              hour = initalHour
            }
            startDate.push(hour)
            startDate.push(Number(splitDate[1]))

            let splitEndDate = calendarItems[item].endDate.split("-")
            endDate.push(Number(splitEndDate[0]))
            endDate.push(Number(splitEndDate[1]))
            splitEndDate = splitEndDate[2].split("T")
            endDate.push(Number(splitEndDate[0]))
            splitEndDate = splitEndDate[1].split(":")
            let initialEndHour = Number(splitEndDate[0])
            let endOffset = splitEndDate[2].split("+")
            let endHour = 00
            if (offset.length >= 2) {
              endHour = initialEndHour + Number(offset[1])
            } else {
              endHour = initialEndHour
            }
            endDate.push(endHour)
            endDate.push(Number(splitEndDate[1]))

            let event = {
              title: calendarItems[item].title,
              description: calendarItems[item].description,
              start: startDate,
              end: endDate,
              url: calendarItems[item].url
            }

            events.push(event)
          }

          ics.createEvents(events, (error, value) => {
            if (!error) {
              res.status(200)
              res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
              res.send(value)
            } else {
              console.log('Error creating ical event: ', error)
              res.status(500)
              res.send(JSON.stringify({
                error: {
                  id: 'unable-to-build-calendar',
                  message: 'Could not build calendar'
                }
              }));
            }
          })

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