#!/bin/sh
set -eu
# All policies apply inside the new WAN test container network namespace.
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -p tcp --dport 15897 -m owner ! --uid-owner 0 -j REJECT
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
if [ "${WAN_PORT:-31483}" = 443 ]; then
    peers=$(awk -v name="$WAN_ENDPOINT" '$2 == name { print $1 }' /etc/hosts)
    test -n "$peers"
    iptables -N AWC_WAN_PEERS
    iptables -A OUTPUT -o eth0 -p tcp --dport 443 -m owner --uid-owner 0 -j AWC_WAN_PEERS
    for address in $peers; do
        iptables -A AWC_WAN_PEERS -d "$address/32" -j ACCEPT
    done
else
    iptables -A OUTPUT -o eth0 -p tcp -d "$WAN_ENDPOINT" --dport 31483 -m owner --uid-owner 0 -j ACCEPT
fi
iptables -A OUTPUT -o awwan0 -p tcp -d 10.203.73.2 --dport 18443 -j ACCEPT
exec /usr/local/bin/easytier-core --disable-env-parsing --config-file /etc/wan.toml --rpc-portal 127.0.0.1:15897 --console-log-level warn >/dev/null 2>&1
