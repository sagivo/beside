const { clean } = require('./hooks-shared.cjs');

module.exports = async function afterPack() {
  await clean();
  console.log('[desktop] removed staged sharp/@img from node_modules');
};
