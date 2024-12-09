const { queue } = require('async');


const createQueue = (domain, actions) => queue(async (action, callback) => {
    actions.push(action);
  
    if (actions.length > 2000) {
      console.log('inserting actions to database', { apiKey: domain.apiKey, count: actions.length });
  
      const copyOfActions = _.cloneDeep(actions);
      actions.splice(0, actions.length);
  
      goal(copyOfActions);
    }
  
    callback();
}, 100000000);


const drainQueue = async (domain, actions, q) => {
if (q.length() > 0) await q.drain();

if (actions.length > 0) {
    goal(actions)
}

return true;
};


module.exports = { createQueue, drainQueue };