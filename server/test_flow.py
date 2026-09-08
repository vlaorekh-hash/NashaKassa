import json
import urllib.parse
import urllib.request

BASE = "http://localhost:3001/api"


def call(method, path, user=None, body=None):
    headers = {"Content-Type": "application/json"}
    if user is not None:
        headers["X-Debug-User"] = urllib.parse.quote(json.dumps(user, ensure_ascii=False))
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


alice = {"id": 1001, "first_name": "Алиса", "username": "alice"}
bob = {"id": 1002, "first_name": "Боб", "username": "bob"}
carl = {"id": 1003, "first_name": "Карл", "username": "carl"}

print("== create group ==")
status, res = call("POST", "/groups", alice, {
    "name": "Касса подруг", "type": "rotation", "amount": 5000, "frequency_days": 30,
})
print(status, res["group"]["name"], "recipient cycle1:", res["cycle"]["recipient"]["first_name"])
gid = res["group"]["id"]

print("== bob & carl join ==")
call("POST", f"/groups/{gid}/join", bob)
status, res = call("POST", f"/groups/{gid}/join", carl)
print(status, "members:", [m["first_name"] for m in res["members"]], "expectedTotal:", res["cycle"]["expectedTotal"])
cid = res["cycle"]["id"]

print("== set payment details for recipient (alice) ==")
call("PUT", "/me/payment-details", alice, {"payment_details": "СБП, Т-Банк, +7 900 000-00-00"})

print("== all three contribute ==")
for u in (alice, bob, carl):
    status, res = call("POST", f"/groups/{gid}/cycles/{cid}/contribute", u, {"amount": 5000})
    print(u["first_name"], "->", status)

print("== try close before confirmations (should 409) ==")
status, res = call("POST", f"/groups/{gid}/cycles/{cid}/close", alice, {})
print(status, res)

print("== alice (recipient) confirms all three ==")
for u in (alice, bob, carl):
    status, res = call("POST", f"/groups/{gid}/cycles/{cid}/confirm", alice, {"telegram_id": u["id"]})
    print("confirm", u["first_name"], "->", status)

print("confirmedTotal now:", res["cycle"]["confirmedTotal"])

print("== close & rotate ==")
status, res = call("POST", f"/groups/{gid}/cycles/{cid}/close", alice, {})
print(status)
print("new cycle number:", res["cycle"]["cycle_number"], "new recipient:", res["cycle"]["recipient"]["first_name"])

print("== bob tries to confirm someone in new cycle (not recipient/creator, should 403) ==")
status, res = call("POST", f"/groups/{gid}/cycles/{res['cycle']['id']}/confirm", bob, {"telegram_id": alice["id"]})
print(status, res)

print("== group detail sanity check ==")
status, res = call("GET", f"/groups/{gid}", carl)
print(status, "cycle#", res["cycle"]["cycle_number"], "confirmedTotal", res["cycle"]["confirmedTotal"])

print("\nALL FLOW STEPS EXECUTED OK")
