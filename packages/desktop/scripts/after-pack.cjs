const { clean, syncRebuiltPluginNativeModules } = require('./hooks-shared.cjs');

module.exports = async function afterPack(context) {
  await syncRebuiltPluginNativeModules(context.appOutDir, context.packager.appInfo.productFilename);
  await clean();
  console.log('[desktop] removed staged sharp/@img from node_modules');
};
