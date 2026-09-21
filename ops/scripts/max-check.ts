import { config } from '../../packages/backend/config.js';

async function request(method:string,path:string,body?:unknown) {
  const r=await fetch(`${config.MAX_API_BASE_URL}${path}`,{method,headers:{Authorization:config.MAX_BOT_TOKEN,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error(`MAX HTTP ${r.status}; проверьте токен, доступ к API и TLS`);
  return await r.json() as Record<string,unknown>;
}
try {
  if(config.MAX_MODE!=='real')throw new Error('Установите MAX_MODE=real и настоящий токен. Mock не проверяет MAX.');
  const bot=await request('GET','/me');
  console.log(JSON.stringify({botName:bot.username,configuredBotName:config.MAX_BOT_NAME,matched:bot.username===config.MAX_BOT_NAME}));
  if(bot.username!==config.MAX_BOT_NAME)throw new Error('MAX_BOT_NAME не совпадает с ботом, которому принадлежит токен.');
  const url=`${config.PUBLIC_APP_URL.replace(/\/$/,'')}/integrations/max/webhook`;
  if(process.argv.includes('--subscribe')) {
    const target=new URL(url);
    if(target.protocol!=='https:'||target.port&&target.port!=='443')throw new Error('Webhook требует публичный HTTPS на порту 443.');
    // Omitting update_types subscribes to all available types. The worker ignores unrelated updates.
    const result=await request('POST','/subscriptions',{url,secret:config.MAX_WEBHOOK_SECRET});
    if(result.success!==true)throw new Error('MAX не подтвердил подписку. Проверьте доступность webhook и сертификат.');
    console.log('Webhook зарегистрирован.');
  }
  const subscriptions=await request('GET','/subscriptions');
  const found=(subscriptions.subscriptions as {url:string}[]|undefined)?.some(s=>s.url===url)??false;
  console.log(JSON.stringify({webhook:url,subscriptionActive:found}));
  if(!found)console.log('Подписка не найдена. После публикации выполните npm run max:check -- --subscribe.');
} catch(e) {
  const code=(e as {cause?:{code?:string}})?.cause?.code;
  console.error(JSON.stringify({error:e instanceof TypeError?'Ошибка сети или TLS':e instanceof Error?e.message:'Ошибка проверки MAX',...(code?{code}:{})}));
  process.exitCode=1;
}
