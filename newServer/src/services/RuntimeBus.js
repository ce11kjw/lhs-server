let wsServer = null;

function setWsServer(instance) {
  wsServer = instance || null;
}

function getWsServer() {
  return wsServer;
}

module.exports = {
  setWsServer,
  getWsServer,
};
