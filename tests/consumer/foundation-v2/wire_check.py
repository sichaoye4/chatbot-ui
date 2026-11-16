"""Independent Python reader of v2 conversation wire snapshots from the compiled consumer host."""

import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    snapshot = json.load(stream)

messages = snapshot["messages"]
assert [message["role"] for message in messages] == ["user", "assistant", "user", "assistant"]
values = []
for message in messages:
    if message["role"] != "assistant":
        continue
    response = message["response"]
    assert response["protocolVersion"] == 2 and response["messageId"] == message["id"]
    assert response["status"] == "complete"
    binding = response["plan"]["bindings"][0]
    descriptor = next(d for d in response["bindingDescriptors"] if d["bindingId"] == binding["id"])
    assert descriptor["source"] == binding["tool"]
    data = response["datasets"][binding["id"]]
    assert data["status"] == "ready" and data["result"]["provenance"]["grain"] == descriptor["grain"]
    field = descriptor["fields"][0]
    visual_block = next(b for b in response["plan"]["blocks"] if b["kind"] == "visual")
    element = visual_block["elements"][0]
    assert element["roles"]["value"] == [{"bindingId": binding["id"], "fieldId": field["id"]}]
    values.append((data["result"]["rows"][0][field["id"]], field["unit"]))

# First response also carries paginated/sorted/refreshed warehouse.items binding
first_response = messages[1]["response"]
items_binding = next(b for b in first_response["plan"]["bindings"] if b["id"] == "items")
assert items_binding["args"].get("sortField") == "name"
assert items_binding["args"].get("sortDirection") == "asc"
assert items_binding["args"].get("cursor") is None
assert any("Refreshed" in w for w in first_response["datasets"]["items"]["result"]["provenance"]["warnings"])

assert values == [(42, "books"), (17, "MW")]
print("Python consumer decoded two persisted v2 HTTP snapshots and verified bindings, sort, refresh, and values")
