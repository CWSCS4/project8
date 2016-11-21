#!/bin/bash
rm $(find . -name "*.asm")
for vm_project in */*; do
	echo Compiling $vm_project
	./compile-vm-project.js $vm_project
done