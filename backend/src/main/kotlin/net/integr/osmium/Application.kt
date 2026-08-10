package net.integr.osmium

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling
import net.integr.osmium.audit.service.AuditService

/**
 * Scheduling drives the three daily retention purges - audit, activity and chat - and the chat
 * listener election, which reconciles on a timer because a host going silent fires no event.
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
class Application

fun main(args: Array<String>) {
    runApplication<Application>(*args)
}
