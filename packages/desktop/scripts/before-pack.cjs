const { stageSharpForArch } = require('./hooks-shared.cjs');

module.exports = async function beforePack(context) {
  await stageSharpForArch(context.electronPlatformName, context.arch);
};
