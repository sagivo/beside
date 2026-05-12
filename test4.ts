const page = { path: 'a\\b' };
const normalised = page.path.replace(/\\/g, '/'), cat = normalised.split('/')[0];
