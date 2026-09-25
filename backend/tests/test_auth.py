"""Auth contract tests."""
from __future__ import annotations


async def test_signup_login_me_refresh(client):
    # signup
    r = await client.post(
        "/api/auth/signup",
        json={"email": "alice@example.com", "password": "password123", "name": "Alice"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["user"]["email"] == "alice@example.com"
    assert body["access_token"] and body["refresh_token"]

    # me
    r = await client.get("/api/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert r.status_code == 200
    assert r.json()["user"]["email"] == "alice@example.com"

    # login
    r = await client.post(
        "/api/auth/login",
        json={"email": "alice@example.com", "password": "password123"},
    )
    assert r.status_code == 200, r.text
    login_body = r.json()
    assert login_body["user"]["id"] == body["user"]["id"]

    # refresh rotates tokens
    r = await client.post("/api/auth/refresh", json={"refresh_token": login_body["refresh_token"]})
    assert r.status_code == 200, r.text
    refreshed = r.json()
    assert refreshed["access_token"] != login_body["access_token"]

    # old refresh token is revoked
    r = await client.post("/api/auth/refresh", json={"refresh_token": login_body["refresh_token"]})
    assert r.status_code == 401


async def test_signup_duplicate_and_bad_login(client):
    r = await client.post(
        "/api/auth/signup",
        json={"email": "bob@example.com", "password": "password123", "name": "Bob"},
    )
    assert r.status_code == 201
    r = await client.post(
        "/api/auth/signup",
        json={"email": "bob@example.com", "password": "password123", "name": "Bob"},
    )
    assert r.status_code == 400

    r = await client.post(
        "/api/auth/login", json={"email": "bob@example.com", "password": "wrongpass1"}
    )
    assert r.status_code == 401

    r = await client.get("/api/me")
    assert r.status_code == 401

    r = await client.get("/api/me", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401
