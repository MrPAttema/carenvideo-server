const webpush = require('web-push');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const Datastore = require('nedb');
const cors = require('cors');

const gcmServerKey = 'AAAAEFHh8-4:APA91bFWuoio6hVb1Nrx3CV5DPCc_Zeqvi1EohpUvEQpSdwdQd696x6HBy0vJPrhjc3fwOobP_DPklCNsxxIU7mW_RQ1vct_DLThKbOSnGRLRFYlEPVa4W381FFLtRRs3FS4YMASNqOI';
webpush.setGCMAPIKey(gcmServerKey);

const vapidKeys = {
  publicKey: 'BOvQGEjUy9zXOPx6bI4hL5sSQaGLE95k0EuOe2Yb1PCkfKyQDBt7cGRYgpuQN3C3WcpAjwzRNmW-LTcDUcHsxUU',
  privateKey: 'jDYm9D1zCd2OvUufTQ_8grPkacY9BTHi4fV2LUEwHwo'
};

webpush.setVapidDetails(
  'mailto:info@carenvideo.nl',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

const db = new Datastore({
  filename: path.join(__dirname, 'subscription-storage.db'),
  autoload: true
});

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

  console.log(req.body)
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

const port = process.env.PORT || 9012;

const server = app.listen(port, function () {
  console.log('Running on http://localhost:' + port);
});