package net.integr.osmium.repository

import net.integr.osmium.model.PermissionNode
import org.springframework.data.jpa.repository.JpaRepository

interface PermissionNodeRepository : JpaRepository<PermissionNode, String>
