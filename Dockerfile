FROM oznu/homebridge:ubuntu
RUN apt update
RUN apt-get install python3
RUN pip3 install pyatv  "srptools==1.0.1"
