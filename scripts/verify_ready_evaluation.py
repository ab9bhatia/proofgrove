import os,sys,tempfile,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'scripts'))
from lab_profile import environments
_,env,_=environments({},root)
with tempfile.TemporaryDirectory(prefix='proofgrove-seed-check-') as d:
    env.update(DATABASE_URL='sqlite+aiosqlite:///'+str(Path(d)/'lab.db'),PYTHONPATH=str(root/'scripts')+':'+str(root/'backend/src'),APP_LOG_LEVEL='WARNING')
    code='''
from fastapi.testclient import TestClient
import seed_ready_evaluation as s
from seed_demo import request,wait_for_run
with TestClient(s.app,headers={'x-evalai-tenant':s.SLUG,'x-evalai-sub':'local-instructor'}) as c:
    s.seed(c);s.seed(c)
    rows=request(c,'GET',f'/datasets/{s.DATASET}/records')
    assert len(rows)==8
    assert request(c,'GET',f'/datasets/{s.DATASET}')['status']=='PUBLISHED'
    assert len([p for p in request(c,'GET','/platform/quality-profiles') if p['profile_id']==s.PROFILE])==1
    body={'response_source':'provided','project_id':s.PROJECT,'evaluation_name':'Isolated readiness check','evaluation_scope':'final_response','active_metrics':s.METRICS,'enable_llm_judge':False,'parallel_requests':1}
    readiness=request(c,'POST',f'/evaluation/runs/from-dataset/{s.DATASET}/readiness',json=body)
    assert readiness['status']=='ready',readiness
    job=request(c,'POST',f'/evaluation/runs/from-dataset/{s.DATASET}',json=body)
    run=wait_for_run(c,job['run_id'])
    scores=[r for r in run['metric_results'] if r['metric_id'] in s.METRICS]
    assert len(scores)==24 and all(r['score'] is not None for r in scores)
    # Resume an empty partial seed with known ownership.
    s.DATASET='partial_seed_check'
    request(c,'POST','/datasets',json={'dataset_name':s.DATASET,'tenant_id':s.TENANT,'product_id':'fictional-nova','created_by':s.CREATOR})
    s.seed(c)
    assert request(c,'GET',f'/datasets/{s.DATASET}')['status']=='PUBLISHED'
    # Preserve a user-edited draft even if it originally belonged to the seeder.
    s.DATASET='edited_draft_check'
    request(c,'POST','/datasets',json={'dataset_name':s.DATASET,'tenant_id':s.TENANT,'product_id':'fictional-nova','created_by':s.CREATOR})
    changed=s.records()[:1];changed[0]['inputs']['response']='User-edited answer'
    request(c,'POST',f'/datasets/{s.DATASET}/records',json={'records':changed})
    s.seed(c)
    retained=request(c,'GET',f'/datasets/{s.DATASET}/records')
    assert len(retained)==1 and retained[0]['inputs']['response']=='User-edited answer'
    assert request(c,'GET',f'/datasets/{s.DATASET}')['status']=='DRAFT'
print('PASS: repeat seed, partial recovery, edited-draft preservation, ready launch and 24 real deterministic scores.')
'''
    result=subprocess.run([str(root/'backend/.venv/bin/python'),'-c',code],cwd=root/'backend',env=env,capture_output=True,text=True)
    if result.returncode:print(result.stdout[-2500:],result.stderr[-3500:]);sys.exit(result.returncode)
    print(result.stdout[-1800:])
