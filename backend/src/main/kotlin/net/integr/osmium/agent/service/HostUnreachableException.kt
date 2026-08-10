package net.integr.osmium.agent.service
import net.integr.osmium.host.model.Host

/**
 * Thrown when a command cannot be delivered because the owning host has no live host connection.
 *
 * Commands are never queued for later delivery: a disconnect that fires twenty minutes late, after
 * an operator has already fixed things by hand, is worse than an immediate failure. See the
 * "Undeliverable commands fail fast" section of FLEET_CONNECTIVITY.md.
 */
class HostUnreachableException(hostName: String) :
    RuntimeException("Host '$hostName' is not connected, so the command cannot be delivered")
