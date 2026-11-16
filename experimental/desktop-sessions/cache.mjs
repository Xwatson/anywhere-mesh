import { Journal } from '../execution/journal.mjs';
import { canonical } from '../execution/protocol.mjs';

export class DesktopCache extends Journal {
  constructor(path){super(path);this.db.exec('CREATE TABLE IF NOT EXISTS cached_events(session_id TEXT,seq INTEGER,ts INTEGER,event TEXT,PRIMARY KEY(session_id,seq))');}
  merge(page){
    const s=this.get('sessions',page.sessionId);if(!s||s.workspaceId!==page.workspaceId||s.historyEpoch!==page.historyEpoch)throw Error('HISTORY_BINDING_MISMATCH');
    const prior=this.get('cursors',s.id)??{seq:0};let seq=prior.seq;
    this.tx(()=>{
      for(const r of page.events){
        if(!Number.isSafeInteger(r.seq)||!Number.isSafeInteger(r.ts)||!r.event||typeof r.event.type!=='string')throw Error('INVALID_HISTORY_EVENT');
        if(r.seq<=seq){const old=this.db.prepare('SELECT event FROM cached_events WHERE session_id=? AND seq=?').get(s.id,r.seq);if(!old||canonical(JSON.parse(old.event))!==canonical(r.event))throw Error('HISTORY_CONFLICT');continue;}
        if(r.seq!==seq+1)throw Error('HISTORY_GAP');
        this.db.prepare('INSERT INTO cached_events VALUES(?,?,?,?)').run(s.id,r.seq,r.ts,JSON.stringify(r.event));seq=r.seq;
      }
      if(page.throughSeq>seq||!Number.isSafeInteger(page.throughSeq))throw Error('HISTORY_CURSOR_MISMATCH');
      this.put('cursors',s.id,{seq});
    });return seq;
  }
  page(sessionId,beforeSeq=0){
    const s=this.get('sessions',sessionId);if(!s)throw Error('SESSION_NOT_CACHED');
    const rows=this.db.prepare('SELECT seq,ts,event FROM cached_events WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT 60').all(sessionId,beforeSeq||Number.MAX_SAFE_INTEGER);
    const events=[];let bytes=0;
    for(const r of rows){const row={seq:Number(r.seq),ts:Number(r.ts),event:JSON.parse(r.event)},n=Buffer.byteLength(JSON.stringify(row));if(bytes+n>140000)break;events.unshift(row);bytes+=n;}
    const firstSeq=events[0]?.seq??0;return {sessionId,workspaceId:s.workspaceId,historyEpoch:s.historyEpoch,events,firstSeq,hasMore:firstSeq>1,cached:true};
  }
}
