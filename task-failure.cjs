// Provider failures need explicit continuation, not replay of possibly completed tools.
function classifyFailure(error){
 const message=String(error&&error.message||error||'');
 if(/engine.*overloaded|server.*overloaded|temporarily overloaded|capacity.*exceeded/i.test(message))return 'provider_overloaded';
 if(/rate[ _-]?limit|too many requests/i.test(message))return 'rate_limited';
 return null;
}
function failureHint(job){
 const kind=job.failureKind||classifyFailure(job.error);
 if(job.status!=='failed'||!kind)return '';
 const reason=kind==='provider_overloaded'?'模型服务暂时过载':'模型接口触发限流';
 const retry=job.providerRetryCount>0?'Codex 已进行 '+job.providerRetryCount+' 次连接重试，仍未恢复。':'';
 const safety=job.retryBlocked==='submission-uncertain'?'提交是否被受理尚未确认，为防止重复执行未自动重发。':job.turnSubmitted?'任务已提交，可能已经执行部分操作；为防止重复执行未自动重发。':'任务未完成。';
 const recovery=job.threadId?'群和任务会话仍保留；稍后在本群回复“继续”，将续接原任务会话，不需要重新建群。':'群仍保留；稍后在本群回复“继续”重新启动任务，不需要重新建群。';
 return reason+'，不是建群失败。'+retry+'\n'+safety+'\n'+recovery;
}
module.exports={classifyFailure,failureHint};
