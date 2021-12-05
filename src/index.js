require('dotenv').config();
const axios = require('axios');
const Koa = require('koa');
const koaBody = require('koa-body');
const Router = require('@koa/router');
const _ = require('lodash');

const app = new Koa();
const router = new Router();

app.use(koaBody());

let accessToken;
let expiresAt = 0;

const parseLink = link => link && link.split('>')[0].replace('<', '');

const getDefaultOptions = () => ({
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': process.env.USER_AGENT,
    Accept: '*/*',
  },
});

const paginatedRequest = async (options, parseItem = i => i) => {
  const enrichedOptions = _.defaultsDeep(options, getDefaultOptions());
  let nextUrl = enrichedOptions.url;
  const wholeData = [];

  while (nextUrl) {
    const { data, headers } = await axios({ ...enrichedOptions, url: nextUrl });
    wholeData.push(...data.map(parseItem));
    nextUrl = parseLink(headers.link);
  }

  return wholeData;
};

const simpleRequest = async (options) => {
  const enrichedOptions = _.defaultsDeep(options, getDefaultOptions());
  let nextUrl = enrichedOptions.url;

  const { data } = await axios(enrichedOptions);

  return data;
};

const refreshToken = async () => {
  const { data } = await axios({
    method: 'post',
    url: 'https://launchpad.37signals.com/authorization/token',
    params: {
      type: 'refresh',
      refresh_token: process.env.REFRESH_TOKEN,
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      redirect_uri: process.env.REDIRECT_URI,
    },
  });

  accessToken = data.access_token;
  expiresAt = new Date().valueOf() + data.expires_in * 1000;
};

const ensureTokenValidity = async () => {
  if (!accessToken || expiresAt - new Date().valueOf() > 10 * 60 * 1000) { // refresh if less than 10 minutes left
    await refreshToken();
  } else {
    try {
      await simpleRequest({ url: `https://3.basecampapi.com/${process.env.BASECAMP_ACCOUNT}/my/profile.json` })
    } catch {
      await refreshToken();
    }
  }
}

const processWebhook = async (data) => {
  try {
    if (data.kind !== 'inbox_forward_created') {
      return;
    }

    await ensureTokenValidity();
    const bucket = data.recording.bucket.id;
    const subscriptionUrl = data.recording.subscription_url;
    const commentUrl = subscriptionUrl.replace('subscription', 'comments');

    const peopleInBucket = await paginatedRequest({
      url: `https://3.basecampapi.com/${process.env.BASECAMP_ACCOUNT}/projects/${bucket}/people.json`
    }, person => person.id);

    await simpleRequest({
      method: 'PUT',
      url: subscriptionUrl,
      data: { subscriptions: peopleInBucket },
    });

    await simpleRequest({
      method: 'POST',
      url: commentUrl,
      data: { content: 'Someone sent this email.' },
    });
  } catch (e) {
    if (_.get(e, 'response.data')) {
      console.log(e.response.data);
    } else {
      console.log(e);
    }
  }
};

router.post('/new-email', async ctx => {
  // answering directly
  processWebhook(ctx.request.body);

  ctx.status = 200;
});

router.get('/health', async ctx => {
  ctx.body = 'ok';
});

app.use(router.routes());
app.listen(8000);
