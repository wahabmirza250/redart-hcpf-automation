'use strict';

// A lease owns the browser until close(). Waiting jobs cannot touch it.
// Idle expiry acquires the same lock, so it cannot log out an active claim.
class PortalSessionPool {
  constructor({idleMs=300000,maxAgeMs=28800000,now=Date.now}={}) {
    this.idleMs=idleMs; this.maxAgeMs=maxAgeMs; this.now=now;
    this.entries=new Map(); this.tails=new Map();
  }
  async lock(key) {
    const previous=this.tails.get(key)||Promise.resolve();
    let release;
    const tail=new Promise(resolve=>{release=resolve;});
    this.tails.set(key,tail);
    await previous;
    return ()=>{release();if(this.tails.get(key)===tail)this.tails.delete(key);};
  }
  async dispose(key,entry) {
    clearTimeout(entry.timer);
    if(this.entries.get(key)===entry)this.entries.delete(key);
    return entry.session.close();
  }
  async acquire(key,{open,validate}) {
    const unlock=await this.lock(key);
    let entry=this.entries.get(key);
    try {
      if(entry) {
        clearTimeout(entry.timer);
        entry.timer=null;
        entry.generation=(entry.generation||0)+1;
        const expired=this.now()-entry.createdAt>=this.maxAgeMs;
        const valid=!expired && await validate(entry.session);
        if(!valid){await this.dispose(key,entry);entry=null;}
      }
      if(!entry) {
        entry={session:await open(),createdAt:this.now(),timer:null};
        this.entries.set(key,entry);
      }
      let released=false,discard=false;
      return {...entry.session,reusedSession:entry.used===true||entry.session.reusedSession,
        invalidate(){discard=true;},
        close:async({logout=false}={})=>{
          if(released)return {retained:false};
          released=true;entry.used=true;
          try {
            if(discard||logout)return await this.dispose(key,entry);
            // Cookie checkpoints aid restart recovery; a checkpoint failure
            // must not turn a saved claim receipt into a failed bill.
            try {await entry.session.checkpoint?.();}
            catch {console.warn('PORTAL_SESSION_CHECKPOINT_FAILED');}
            console.log('PORTAL_SESSION_RETAINED');
            const generation=entry.generation||0;
            entry.timer=setTimeout(()=>{
              this.expire(key,entry,generation).catch(err=>console.warn('PORTAL_IDLE_LOGOUT_FAILED:',err.message));
            },this.idleMs);
            entry.timer.unref?.();
            return {retained:true,loggedOut:false};
          } finally {unlock();}
        }};
    } catch(err) {
      if(entry)await this.dispose(key,entry).catch(()=>{});
      unlock();throw err;
    }
  }
  async expire(key,entry,generation) {
    const unlock=await this.lock(key);
    try {
      // A fresh lease cancels its timer before this check. A timer that already
      // fired must not dispose a replacement browser.
      if(this.entries.get(key)===entry && entry.timer && (entry.generation||0)===generation) {
        await this.dispose(key,entry);
      }
    } finally {unlock();}
  }
}

module.exports={PortalSessionPool};
