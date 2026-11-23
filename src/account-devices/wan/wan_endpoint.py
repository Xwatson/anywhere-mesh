"""Validate the single endpoint used by this WAN test deployment."""
from ipaddress import IPv4Address
import re


def endpoint(value):
    try:
        return str(IPv4Address(value)), False
    except ValueError:
        host = value.lower().rstrip('.')
        labels = host.split('.')
        if (len(host) > 253 or len(labels) < 2 or labels[-1].isdigit() or
                not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', x) for x in labels)):
            raise ValueError('Expected an IPv4 address or DNS hostname')
        return host, True


def peer_uri(value):
    host, domain = endpoint(value)
    return f'wss://{host}/easytier' if domain else f'wss://{host}:31483/'


def wire_listener(domain):
    return 'ws://127.0.0.1:31483/' if domain else 'wss://127.0.0.1:31483/'
