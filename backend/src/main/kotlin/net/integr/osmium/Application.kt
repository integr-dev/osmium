package net.integr.osmium

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling

/** Scheduling drives one job: the daily audit-retention purge in `AuditService`. */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
class Application

fun main(args: Array<String>) {
    runApplication<Application>(*args)
}
