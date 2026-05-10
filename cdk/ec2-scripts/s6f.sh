#!/bin/bash
if [ -f /etc/hosts.bak ]; then sudo cp /etc/hosts.bak /etc/hosts; sudo rm -f /etc/hosts.bak; fi
