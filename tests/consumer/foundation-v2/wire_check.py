"""Independent Python reader of the subset of v2 snapshots used by this host."""

import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    messages = json.load(stream)

assert [message["role"] for message in messages] == ["user", "assistant", "user", "assistant"]
values = []
for message in messages:
    if message["role"] != "assistant":
        continue
    response = message["response"]
    assert response["protocolVersion"] == 2 and response["messageId"] == message["id"]
    assert response["status"] == "complete" and response["revision"] == 1
    binding = response["plan"]["bindings"][0]
    descriptor = response["bindingDescriptors"][0]
    assert descriptor["bindingId"] == binding["id"] and descriptor["source"] == binding["tool"]
    data = response["datasets"][binding["id"]]
    assert data["status"] == "ready" and data["result"]["provenance"]["grain"] == descriptor["grain"]
    field = descriptor["fields"][0]
    element = response["plan"]["blocks"][0]["elements"][0]
    assert element["roles"]["value"] == [{"bindingId": binding["id"], "fieldId": field["id"]}]
    values.append((data["result"]["rows"][0][field["id"]], field["unit"]))

assert values == [(42, "books"), (17, "MW")]
print("Python consumer decoded two v2 snapshots and verified their bindings and values")
