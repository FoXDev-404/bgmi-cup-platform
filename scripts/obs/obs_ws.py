"""Minimal synchronous obs-websocket v5 client for the BGMI Cup tooling.

Uses websocket-client (Apache-2.0, pinned in requirements.txt) installed
into the isolated venv at scripts/obs/.venv - the app itself stays
stdlib-only.

Only the request/response side of the protocol is implemented (event
subscriptions are disabled in Identify; stray events are skipped).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import uuid

import websocket

import obs_config


class ObsError(RuntimeError):
    def __init__(self, request_type, code, comment):
        super().__init__("%s failed (code %s): %s" % (request_type, code, comment))
        self.code = code
        self.comment = comment


class Obs:
    def __init__(self, host=None, port=None, password=None, timeout=20.0):
        if password is None:
            host, port, password = obs_config.obs_ws_url()
        self.host = host
        self.port = int(port)
        self.password = password
        self.timeout = timeout
        self._ws = None

    # -- connection ---------------------------------------------------------
    def connect(self):
        self._ws = websocket.create_connection(
            "ws://%s:%s" % (self.host, self.port), timeout=self.timeout)
        hello = json.loads(self._ws.recv())
        if hello.get("op") != 0:
            raise ObsError("Hello", -1, "unexpected first message from OBS")
        d = hello.get("d") or {}
        identify = {"rpcVersion": 1, "eventSubscriptions": 0}
        auth = d.get("authentication")
        if auth:
            secret = base64.b64encode(hashlib.sha256(
                (self.password + auth["salt"]).encode("utf-8")).digest())
            identify["authentication"] = base64.b64encode(hashlib.sha256(
                secret + auth["challenge"].encode("utf-8")).digest()).decode("utf-8")
        self._ws.send(json.dumps({"op": 1, "d": identify}))
        identified = json.loads(self._ws.recv())
        if identified.get("op") != 2:
            raise ObsError("Identify", -1,
                           "OBS rejected the websocket password")
        return self

    def close(self):
        if self._ws is not None:
            try:
                self._ws.close()
            finally:
                self._ws = None

    def __enter__(self):
        return self.connect()

    def __exit__(self, *exc):
        self.close()
        return False

    # -- requests -----------------------------------------------------------
    def _recv_for(self, request_id, deadline):
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise ObsError("recv", -1, "timed out waiting for OBS")
            self._ws.settimeout(max(0.1, remaining))
            try:
                msg = self._ws.recv()
            except Exception as exc:  # websocket timeout / closed socket
                raise ObsError("recv", -1, str(exc))
            if msg in (None, ""):
                raise ObsError("recv", -1, "OBS closed the connection")
            data = json.loads(msg)
            if data.get("op") != 7:
                continue                      # events / hello / identified
            d = data["d"]
            if d.get("requestId") != request_id:
                continue
            return d

    def req(self, request_type, request_data=None, ok_codes=(100,)):
        rid = uuid.uuid4().hex
        self._ws.send(json.dumps({"op": 6, "d": {
            "requestType": request_type, "requestId": rid,
            "requestData": request_data or {}}}))
        d = self._recv_for(rid, time.time() + self.timeout)
        status = d.get("requestStatus") or {}
        code = status.get("code")
        if status.get("result") is True or code in ok_codes:
            return d.get("responseData") or {}
        raise ObsError(request_type, code, status.get("comment", ""))

    def try_req(self, request_type, request_data=None, ok_codes=(100,)):
        """Like req() but returns None instead of raising."""
        try:
            return self.req(request_type, request_data, ok_codes)
        except ObsError:
            return None

    # -- helpers ------------------------------------------------------------
    def screenshot(self, source_name, path, width=1920, height=1080,
                   fmt="jpg", quality=90):
        data = self.req("GetSourceScreenshot", {
            "sourceName": source_name, "imageFormat": fmt,
            "imageWidth": width, "imageHeight": height,
            "imageCompressionQuality": quality})
        img = data.get("imageData") or ""
        if "," in img:
            img = img.split(",", 1)[1]
        blob = base64.b64decode(img)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(blob)
        return path

    def scene_item_id(self, scene, source):
        return self.req("GetSceneItemId",
                        {"sceneName": scene, "sourceName": source})["sceneItemId"]

    def set_item_locked(self, scene, item_id, locked=True):
        """v5 exposes Get/SetSceneItemLocked; returns False if unsupported."""
        return self.try_req("SetSceneItemLocked", {
            "sceneName": scene, "sceneItemId": item_id,
            "sceneItemLocked": bool(locked)}) is not None

    def get_item_locked(self, scene, item_id):
        data = self.try_req("GetSceneItemLocked",
                            {"sceneName": scene, "sceneItemId": item_id})
        return None if data is None else bool(data.get("sceneItemLocked"))
