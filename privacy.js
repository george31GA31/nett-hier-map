(() => {
  const $=id=>document.getElementById(id);let widget;
  const config=window.NETT_HIER_CONFIG;
  async function api(payload){
    const r=await fetch(`${config.supabaseUrl}/functions/v1/public-api`,{method:'POST',headers:{'Content-Type':'application/json',apikey:config.supabasePublishableKey},body:JSON.stringify(payload)});
    const data=await r.json();if(!r.ok)throw new Error(data.error||'The contact service is unavailable. Please try again later.');return data;
  }
  async function init(){try{
    const settings=await api({action:'config'});
    if(!settings.ready||!settings.turnstileSiteKey)throw new Error('Private requests are being prepared. Please try again later.');
    if(!window.turnstile){setTimeout(init,300);return;}
    widget=window.turnstile.render($('supportCaptcha'),{sitekey:settings.turnstileSiteKey,action:'submission',size:'flexible'});
  }catch(e){$('supportMessage').textContent=e.message;}}
  init();
  $('supportForm').addEventListener('submit',async event=>{
    event.preventDefault();$('supportSubmit').disabled=true;
    try {
      const captchaToken=widget!=null&&window.turnstile?.getResponse(widget);
      if(!captchaToken)throw new Error('Please complete the bot check.');
      await api({action:'support',spot_id:$('supportSpot').value.trim()||null,reply_to:$('supportEmail').value.trim()||null,message:$('supportText').value.trim(),captchaToken});
      $('supportForm').reset();$('supportMessage').textContent='Your private request is in the owner’s moderation inbox.';
    }catch(e){$('supportMessage').textContent=e.message;}finally{$('supportSubmit').disabled=false;if(widget!=null)window.turnstile?.reset(widget);}
  });
})();
